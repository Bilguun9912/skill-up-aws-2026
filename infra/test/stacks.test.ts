import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { makeApp } from './helpers';

const REAL_CONFIG = {
  modelId: 'jp.anthropic.claude-sonnet-test-v1:0',
  queryRewriteModelId: 'apac.amazon.nova-lite-v1:0',
  budget: { monthlyLimitUsd: 100, alertThresholdsUsd: [10, 30, 60], email: 'ops@example.com' },
  cognitoDomainPrefix: 'pmbok-assistant-test',
};

describe('app', () => {
  test('all six stacks synthesize together (no dependency cycles)', () => {
    const { app } = makeApp();
    const assembly = app.synth();
    expect(assembly.stacks.map((s) => s.stackName).sort()).toEqual(
      ['Pmbok-Api', 'Pmbok-Auth', 'Pmbok-Data', 'Pmbok-Frontend', 'Pmbok-Knowledge', 'Pmbok-Ops'].sort(),
    );
  });

  test('stack dependency direction matches architecture', () => {
    const { app, stacks } = makeApp();
    app.synth(); // reference-based dependencies are resolved during synth
    const deps = (s: { dependencies: { stackName: string }[] }) => s.dependencies.map((d) => d.stackName).sort();
    expect(deps(stacks.ops)).toEqual([]);
    expect(deps(stacks.auth)).toEqual([]);
    expect(deps(stacks.data)).toEqual([]);
    expect(deps(stacks.knowledge)).toEqual(['Pmbok-Data']);
    expect(deps(stacks.api)).toEqual(['Pmbok-Auth', 'Pmbok-Data', 'Pmbok-Knowledge']);
    expect(deps(stacks.frontend)).toEqual(['Pmbok-Api', 'Pmbok-Auth']);
  });

  test('every resource-bearing stack is tagged', () => {
    const { stacks } = makeApp();
    Template.fromStack(stacks.data).hasResourceProperties('AWS::DynamoDB::Table', {
      Tags: Match.arrayWith([
        { Key: 'env', Value: 'dev' },
        { Key: 'owner', Value: 'pmbok-poc' },
        { Key: 'project', Value: 'pmbok-assistant' },
      ]),
    });
  });

  test('placeholder config produces a warning, real config does not', () => {
    const withPlaceholders = makeApp();
    Annotations.fromStack(withPlaceholders.stacks.ops).hasWarning('*', Match.stringLikeRegexp('CHANGE-ME'));
    const real = makeApp(REAL_CONFIG);
    expect(
      Annotations.fromStack(real.stacks.ops).findWarning('*', Match.stringLikeRegexp('CHANGE-ME')),
    ).toHaveLength(0);
  });
});

describe('Pmbok-Ops', () => {
  test('monthly COST budget with ACTUAL email alert per threshold', () => {
    const { stacks } = makeApp(REAL_CONFIG);
    const t = Template.fromStack(stacks.ops);
    t.resourceCountIs('AWS::Budgets::Budget', 1);
    t.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: { BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: 100, Unit: 'USD' } },
      NotificationsWithSubscribers: [10, 30, 60].map((threshold) => ({
        Notification: {
          NotificationType: 'ACTUAL',
          ComparisonOperator: 'GREATER_THAN',
          Threshold: threshold,
          ThresholdType: 'ABSOLUTE_VALUE',
        },
        Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'ops@example.com' }],
      })),
    });
  });
});

describe('Pmbok-Auth', () => {
  test('self sign-up disabled, managed login domain, no Okta by default', () => {
    const { stacks } = makeApp(REAL_CONFIG);
    const t = Template.fromStack(stacks.auth);
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
    t.hasResourceProperties('AWS::Cognito::UserPoolDomain', { Domain: 'pmbok-assistant-test', ManagedLoginVersion: 2 });
    t.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 0);
    t.hasOutput('OktaRedirectUri', {
      Value: 'https://pmbok-assistant-test.auth.ap-northeast-1.amazoncognito.com/oauth2/idpresponse',
    });
    t.hasOutput('UserPoolId', {});
    t.hasOutput('CognitoDomain', { Value: 'https://pmbok-assistant-test.auth.ap-northeast-1.amazoncognito.com' });
  });

  test('Okta OIDC IdP with Secrets Manager secret when configured; client supports Okta + COGNITO', () => {
    const { stacks } = makeApp({
      ...REAL_CONFIG,
      okta: { issuerUrl: 'https://example.okta.com', clientId: 'okta-client', clientSecretName: 'pmbok/okta-client-secret' },
    });
    const auth = Template.fromStack(stacks.auth);
    auth.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', {
      ProviderName: 'Okta',
      ProviderType: 'OIDC',
      AttributeMapping: { email: 'email' },
      ProviderDetails: Match.objectLike({
        client_id: 'okta-client',
        client_secret: '{{resolve:secretsmanager:pmbok/okta-client-secret:SecretString:::}}',
        oidc_issuer: 'https://example.okta.com',
      }),
    });
    const fe = Template.fromStack(stacks.frontend);
    const clients = fe.findResources('AWS::Cognito::UserPoolClient');
    const providers = Object.values(clients)[0].Properties.SupportedIdentityProviders;
    expect(providers).toHaveLength(2);
    expect(providers).toContain('COGNITO');
    expect(JSON.stringify(providers)).toContain('OktaIdp');
  });
});

describe('Pmbok-Data', () => {
  test('table keys, on-demand, TTL, DESTROY', () => {
    const { stacks } = makeApp();
    const t = Template.fromStack(stacks.data);
    t.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
        TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      }),
    });
    t.hasOutput('DocsBucketName', {});
  });
});

describe('S3 buckets', () => {
  test('no public buckets anywhere; SSL enforced; auto-delete', () => {
    const { stacks } = makeApp();
    for (const stack of [stacks.data, stacks.frontend]) {
      const t = Template.fromStack(stack);
      const buckets = t.findResources('AWS::S3::Bucket');
      expect(Object.keys(buckets).length).toBeGreaterThan(0);
      for (const b of Object.values(buckets)) {
        expect(b.Properties.PublicAccessBlockConfiguration).toEqual({
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        });
        expect(b.DeletionPolicy).toBe('Delete');
      }
      // enforceSSL → a Deny on aws:SecureTransport=false
      t.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
          ]),
        },
      });
      t.resourcePropertiesCountIs('Custom::S3AutoDeleteObjects', {}, Object.keys(buckets).length);
    }
  });
});

describe('Pmbok-Knowledge', () => {
  test('S3 Vectors index: float32 / 1024 / cosine / non-filterable Bedrock keys', () => {
    const { stacks } = makeApp();
    const t = Template.fromStack(stacks.knowledge);
    t.resourceCountIs('AWS::S3Vectors::VectorBucket', 1);
    t.hasResourceProperties('AWS::S3Vectors::Index', {
      DataType: 'float32',
      Dimension: 1024,
      DistanceMetric: 'cosine',
      MetadataConfiguration: { NonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'] },
    });
  });

  test('KB is VECTOR with Titan v2 embeddings and S3_VECTORS storage', () => {
    const { stacks } = makeApp();
    const t = Template.fromStack(stacks.knowledge);
    t.hasResourceProperties('AWS::Bedrock::KnowledgeBase', {
      KnowledgeBaseConfiguration: {
        Type: 'VECTOR',
        VectorKnowledgeBaseConfiguration: {
          EmbeddingModelArn: Match.stringLikeRegexp('foundation-model/amazon.titan-embed-text-v2:0$'),
          EmbeddingModelConfiguration: { BedrockEmbeddingModelConfiguration: { Dimensions: 1024 } },
        },
      },
      StorageConfiguration: {
        Type: 'S3_VECTORS',
        S3VectorsConfiguration: { IndexArn: { 'Fn::GetAtt': ['VectorIndex', 'IndexArn'] } },
      },
    });
  });

  test('data source: pmbok/ prefix, fixed-size 512 tokens / 15% overlap', () => {
    const { stacks } = makeApp();
    const t = Template.fromStack(stacks.knowledge);
    t.hasResourceProperties('AWS::Bedrock::DataSource', {
      DataSourceConfiguration: { Type: 'S3', S3Configuration: Match.objectLike({ InclusionPrefixes: ['pmbok/'] }) },
      VectorIngestionConfiguration: {
        ChunkingConfiguration: {
          ChunkingStrategy: 'FIXED_SIZE',
          FixedSizeChunkingConfiguration: { MaxTokens: 512, OverlapPercentage: 15 },
        },
      },
    });
    t.hasOutput('KnowledgeBaseId', {});
    t.hasOutput('DataSourceId', {});
  });

  test('KB role: assumable only by Bedrock in this account; scoped permissions', () => {
    const { stacks } = makeApp();
    const t = Template.fromStack(stacks.knowledge);
    t.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Principal: { Service: 'bedrock.amazonaws.com' },
            Condition: Match.objectLike({ StringEquals: { 'aws:SourceAccount': '123456789012' } }),
          }),
        ],
      },
    });
    const policies = t.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap((p) => p.Properties.PolicyDocument.Statement);
    for (const s of statements) expect(s.Resource).not.toBe('*');
    expect(JSON.stringify(statements)).toContain('pmbok/*');
    // KB must wait for its policy (Bedrock validates access at create time)
    t.hasResource('AWS::Bedrock::KnowledgeBase', { DependsOn: Match.arrayWith([Match.stringLikeRegexp('KnowledgeBasePolicy')]) });
  });
});

describe('Pmbok-Api', () => {
  test('Function URL is AWS_IAM + RESPONSE_STREAM', () => {
    const { stacks } = makeApp();
    const t = Template.fromStack(stacks.api);
    t.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM', InvokeMode: 'RESPONSE_STREAM' });
  });

  test('Lambda runtime, arch, timeout, memory, env vars', () => {
    const { stacks } = makeApp(REAL_CONFIG);
    const t = Template.fromStack(stacks.api);
    t.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Timeout: 120,
      MemorySize: 512,
      Environment: {
        Variables: Match.objectLike({
          TABLE_NAME: Match.anyValue(),
          KNOWLEDGE_BASE_ID: Match.anyValue(),
          MODEL_ID: 'jp.anthropic.claude-sonnet-test-v1:0',
          QUERY_REWRITE_MODEL_ID: 'apac.amazon.nova-lite-v1:0',
          MODEL_EFFORT: 'low',
          USER_POOL_ID: Match.anyValue(),
          CLIENT_ID_PARAM: '/pmbok/dev/cognito/client-id',
          DAILY_QUESTION_LIMIT: '30',
          MAX_OUTPUT_TOKENS: '2000',
          HISTORY_TURNS: '5',
          RETRIEVE_TOP_K: '6',
        }),
      },
    });
    t.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });

  test('IAM least privilege: Bedrock models (chat + rewrite), KB Retrieve, one SSM param, no "*" resources', () => {
    const { stacks } = makeApp(REAL_CONFIG);
    const t = Template.fromStack(stacks.api);
    const statements = Object.values(t.findResources('AWS::IAM::Policy')).flatMap(
      (p) => p.Properties.PolicyDocument.Statement,
    );
    for (const s of statements) expect(s.Resource).not.toBe('*');
    const invoke = statements.find((s) => s.Sid === 'InvokeChatModel');
    expect(invoke.Action).toEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
    expect(JSON.stringify(invoke.Resource)).toContain('inference-profile/jp.anthropic.claude-sonnet-test-v1:0');
    expect(invoke.Resource).toEqual(
      expect.arrayContaining([
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-test-v1:0',
        'arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0',
      ]),
    );
    expect(JSON.stringify(invoke.Resource)).toContain('inference-profile/apac.amazon.nova-lite-v1:0');
    const tableStmt = statements.find((s) => s.Sid === 'TableAccess');
    expect([...tableStmt.Action].sort()).toEqual(
      [
        'dynamodb:BatchWriteItem',
        'dynamodb:ConditionCheckItem',
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:Query',
        'dynamodb:TransactWriteItems',
        'dynamodb:UpdateItem',
      ].sort(),
    );
    expect(JSON.stringify(statements)).not.toContain('dynamodb:Scan');
    const retrieve = statements.find((s) => s.Sid === 'RetrieveFromKnowledgeBase');
    expect(retrieve.Action).toBe('bedrock:Retrieve');
    const ssm = statements.find((s) => s.Sid === 'ReadClientIdParam');
    expect(ssm.Action).toBe('ssm:GetParameter');
    expect(JSON.stringify(ssm.Resource)).toContain(':parameter/pmbok/dev/cognito/client-id');
  });

  test('reserved concurrency off by default, settable', () => {
    const off = Template.fromStack(makeApp().stacks.api);
    off.hasResourceProperties('AWS::Lambda::Function', { ReservedConcurrentExecutions: Match.absent() });
    const on = Template.fromStack(makeApp({ reservedConcurrency: 5 }).stacks.api);
    on.hasResourceProperties('AWS::Lambda::Function', { ReservedConcurrentExecutions: 5 });
  });

  test('stub mode emits a warning', () => {
    const { stacks } = makeApp();
    Annotations.fromStack(stacks.api).hasWarning('*', Match.stringLikeRegexp('STUB'));
  });
});

describe('Pmbok-Frontend', () => {
  test('CloudFront uses OAC for both S3 and the Lambda URL', () => {
    const { stacks } = makeApp();
    const t = Template.fromStack(stacks.frontend);
    t.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({ OriginAccessControlOriginType: 's3', SigningBehavior: 'always' }),
    });
    t.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({ OriginAccessControlOriginType: 'lambda', SigningBehavior: 'always' }),
    });
    const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0];
    const origins = dist.Properties.DistributionConfig.Origins;
    expect(origins).toHaveLength(2);
    for (const o of origins) expect(o.OriginAccessControlId).toBeDefined();
  });

  test('/api/* behavior: all methods, caching disabled, forwards only allow-listed headers', () => {
    const { stacks } = makeApp();
    const t = Template.fromStack(stacks.frontend);
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: [
          Match.objectLike({
            PathPattern: '/api/*',
            AllowedMethods: Match.arrayWith(['POST', 'DELETE']),
            CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', // Managed-CachingDisabled
          }),
        ],
      }),
    });
    const orp = Object.values(t.findResources('AWS::CloudFront::OriginRequestPolicy'))[0];
    const cfg = orp.Properties.OriginRequestPolicyConfig;
    expect(cfg.HeadersConfig.HeaderBehavior).toBe('whitelist');
    const headers: string[] = cfg.HeadersConfig.Headers.map((h: string) => h.toLowerCase());
    expect(headers).toEqual(
      expect.arrayContaining(['x-auth-token', 'x-amz-content-sha256', 'content-type', 'x-ui-lang']),
    );
    expect(headers).not.toContain('authorization');
    expect(headers).not.toContain('host');
    expect(cfg.QueryStringsConfig.QueryStringBehavior).toBe('all');
  });

  test('SPA routing does not mask API errors (no distribution error responses; rewrite fn on default only)', () => {
    const { stacks } = makeApp();
    const t = Template.fromStack(stacks.frontend);
    const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0];
    const cfg = dist.Properties.DistributionConfig;
    expect(cfg.CustomErrorResponses).toBeUndefined();
    expect(cfg.DefaultCacheBehavior.FunctionAssociations).toHaveLength(1);
    expect(cfg.CacheBehaviors[0].FunctionAssociations).toBeUndefined();
    expect(cfg.DefaultRootObject).toBe('index.html');
  });

  test('CloudFront may invoke the function URL (InvokeFunctionUrl + InvokeFunction via URL)', () => {
    const { stacks } = makeApp();
    const t = Template.fromStack(stacks.frontend);
    t.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunctionUrl',
      Principal: 'cloudfront.amazonaws.com',
    });
    t.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'cloudfront.amazonaws.com',
      InvokedViaFunctionUrl: true,
    });
  });

  test('User Pool Client: code flow + PKCE-friendly (no secret), CloudFront + localhost callbacks', () => {
    const { stacks } = makeApp();
    const t = Template.fromStack(stacks.frontend);
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      SupportedIdentityProviders: ['COGNITO'],
      AllowedOAuthScopes: ['openid', 'email', 'profile'],
      ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'],
      CallbackURLs: Match.arrayWith(['http://localhost:5173/']),
      LogoutURLs: Match.arrayWith(['http://localhost:5173/']),
    });
    t.resourceCountIs('AWS::Cognito::ManagedLoginBranding', 1);
  });

  test('SSM param with deterministic name holds the client id', () => {
    const { stacks } = makeApp();
    Template.fromStack(stacks.frontend).hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/pmbok/dev/cognito/client-id',
      Value: { Ref: Match.stringLikeRegexp('WebClient') },
    });
  });

  test('without a frontend build only config.json is deployed (and a warning is emitted)', () => {
    const { stacks } = makeApp();
    const t = Template.fromStack(stacks.frontend);
    const dep = Object.values(t.findResources('Custom::CDKBucketDeployment'))[0];
    expect(dep.Properties.SourceObjectKeys).toHaveLength(1);
    expect(JSON.stringify(dep.Properties.SourceMarkersConfig ?? dep.Properties.SourceMarkers)).toBeDefined();
    Annotations.fromStack(stacks.frontend).hasWarning('*', Match.stringLikeRegexp('Frontend build not found'));
    t.hasOutput('CloudFrontUrl', {});
  });

  test('with a frontend build, site assets + config.json are deployed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmbok-dist-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title>');
    try {
      const { stacks } = makeApp({}, { siteAssetsDir: dir });
      const dep = Object.values(Template.fromStack(stacks.frontend).findResources('Custom::CDKBucketDeployment'))[0];
      expect(dep.Properties.SourceObjectKeys).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

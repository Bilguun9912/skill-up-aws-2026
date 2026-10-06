import * as fs from 'node:fs';
import * as path from 'node:path';
import { Annotations, CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { bedrockInvokeResources } from '../bedrock-arns';
import { AppConfig, clientIdParamName } from '../config';

export interface ApiStackProps extends StackProps {
  config: AppConfig;
  table: dynamodb.ITable;
  userPool: cognito.IUserPool;
  knowledgeBase: bedrock.CfnKnowledgeBase;
  /** Override for tests; defaults to ../backend */
  backendDir?: string;
}

export const BACKEND_DIR = path.resolve(__dirname, '../../../backend');
export const BACKEND_ENTRY_REL = 'src/handlers/api.ts';

/** Inline stand-in used by tests (apiCodeStub=true) or when ../backend isn't there yet. */
const STUB_CODE = `
exports.handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const s = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 503,
    headers: { 'content-type': 'application/json' },
  });
  s.write(JSON.stringify({ error: { code: 'internal', message: 'API not deployed (stub)' } }));
  s.end();
});
`;

/** api Lambda (single router, ADR-008) + Function URL (AWS_IAM, RESPONSE_STREAM; ADR-007). */
export class ApiStack extends Stack {
  readonly fn: lambda.IFunction;
  readonly functionUrl: lambda.FunctionUrl;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config, table, userPool, knowledgeBase } = props;
    const clientIdParam = clientIdParamName(config.stage);

    const logGroup = new logs.LogGroup(this, 'ApiLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const environment: Record<string, string> = {
      TABLE_NAME: table.tableName,
      KNOWLEDGE_BASE_ID: knowledgeBase.attrKnowledgeBaseId,
      MODEL_ID: config.modelId,
      QUERY_REWRITE_MODEL_ID: config.queryRewriteModelId,
      MODEL_EFFORT: config.modelEffort,
      USER_POOL_ID: userPool.userPoolId,
      CLIENT_ID_PARAM: clientIdParam,
      DAILY_QUESTION_LIMIT: String(config.dailyQuestionLimit),
      MAX_OUTPUT_TOKENS: String(config.maxOutputTokens),
      HISTORY_TURNS: String(config.historyTurns),
      RETRIEVE_TOP_K: String(config.retrieveTopK),
      NODE_OPTIONS: '--enable-source-maps',
    };

    const common = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(120),
      memorySize: 512,
      logGroup,
      environment,
      reservedConcurrentExecutions: config.reservedConcurrency,
      description: 'PMBOK Assistant api (router for /api/*)',
    };

    const backendDir = props.backendDir ?? BACKEND_DIR;
    const backendEntry = path.join(backendDir, BACKEND_ENTRY_REL);
    const backendLockfile = path.join(backendDir, 'package-lock.json');
    const backendReady = fs.existsSync(backendEntry) && fs.existsSync(backendLockfile);
    if (config.apiCodeStub || !backendReady) {
      const reason = config.apiCodeStub
        ? 'apiCodeStub=true'
        : `backend not found (${backendEntry} / package-lock.json)`;
      Annotations.of(this).addWarningV2(
        'pmbok:api-stub',
        `Using an inline STUB for the api Lambda (${reason}). Do not deploy this.`,
      );
      this.fn = new lambda.Function(this, 'ApiFunction', {
        ...common,
        handler: 'index.handler',
        code: lambda.Code.fromInline(STUB_CODE),
      });
    } else {
      // NodejsFunction runs `npx --no-install esbuild` inside projectRoot, so esbuild (and the
      // backend's runtime deps) must be installed there: `cd backend && npm ci`.
      if (!fs.existsSync(path.join(backendDir, 'node_modules', '.bin', 'esbuild'))) {
        throw new Error(
          `Backend dependencies not installed: ${path.join(backendDir, 'node_modules/.bin/esbuild')} is missing. ` +
            'Run "npm ci" in backend/ (backend needs esbuild as a devDependency), ' +
            'or synth with -c apiCodeStub=true for infra-only work.',
        );
      }
      this.fn = new NodejsFunction(this, 'ApiFunction', {
        ...common,
        entry: backendEntry,
        projectRoot: backendDir,
        depsLockFilePath: backendLockfile,
        handler: 'handler',
        bundling: {
          format: OutputFormat.ESM,
          minify: true,
          sourceMap: true,
          target: 'node22',
          mainFields: ['module', 'main'],
          // Some CJS deps call require(); give ESM bundles a require shim.
          banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
        },
      });
    }

    // --- IAM (least privilege, docs/security.md) ---------------------------
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'TableAccess',
        actions: [
          'dynamodb:GetItem',
          'dynamodb:Query',
          'dynamodb:UpdateItem',
          'dynamodb:PutItem',
          'dynamodb:BatchWriteItem',
          'dynamodb:TransactWriteItems',
          'dynamodb:ConditionCheckItem',
        ],
        resources: [table.tableArn],
      }),
    );

    const invokeResources = Array.from(
      new Set([
        ...bedrockInvokeResources(config.modelId, this.partition, this.region, this.account),
        ...bedrockInvokeResources(config.queryRewriteModelId, this.partition, this.region, this.account),
      ]),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'InvokeChatModel',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: invokeResources,
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'RetrieveFromKnowledgeBase',
        actions: ['bedrock:Retrieve'],
        resources: [knowledgeBase.attrKnowledgeBaseArn],
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadClientIdParam',
        actions: ['ssm:GetParameter'],
        // Built from the deterministic name — no CFN reference to the Frontend stack (ADR-006).
        resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: clientIdParam.slice(1) })],
      }),
    );

    this.functionUrl = this.fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    new CfnOutput(this, 'ApiFunctionName', { value: this.fn.functionName });
    new CfnOutput(this, 'ApiFunctionUrl', {
      value: this.functionUrl.url,
      description: 'Not directly callable (AWS_IAM); use the CloudFront URL',
    });
  }
}

import { Annotations, App, Environment, Tags } from 'aws-cdk-lib';
import { AppConfig, findPlaceholders } from './config';
import { ApiStack } from './stacks/api-stack';
import { AuthStack } from './stacks/auth-stack';
import { DataStack } from './stacks/data-stack';
import { FrontendStack } from './stacks/frontend-stack';
import { KnowledgeStack } from './stacks/knowledge-stack';
import { OpsStack } from './stacks/ops-stack';

export interface PmbokStacks {
  ops: OpsStack;
  auth: AuthStack;
  data: DataStack;
  knowledge: KnowledgeStack;
  api: ApiStack;
  frontend: FrontendStack;
}

export interface BuildOptions {
  /** Override frontend dist dir (tests) */
  siteAssetsDir?: string;
  /** Override backend package dir (tests) */
  backendDir?: string;
}

/** Instantiates all six stacks with the dependency graph from docs/architecture.md. */
export function buildPmbokApp(app: App, config: AppConfig, opts: BuildOptions = {}): PmbokStacks {
  const env: Environment = {
    account: config.account ?? process.env.CDK_DEFAULT_ACCOUNT,
    region: config.region,
  };
  const common = { env, config };

  const ops = new OpsStack(app, 'Pmbok-Ops', { ...common, description: 'PMBOK Assistant: budgets' });
  const auth = new AuthStack(app, 'Pmbok-Auth', { ...common, description: 'PMBOK Assistant: Cognito + Okta' });
  const data = new DataStack(app, 'Pmbok-Data', { ...common, description: 'PMBOK Assistant: DynamoDB + docs bucket' });
  const knowledge = new KnowledgeStack(app, 'Pmbok-Knowledge', {
    ...common,
    description: 'PMBOK Assistant: S3 Vectors + Bedrock Knowledge Base',
    docsBucket: data.docsBucket,
  });
  const api = new ApiStack(app, 'Pmbok-Api', {
    ...common,
    description: 'PMBOK Assistant: api Lambda + Function URL',
    table: data.table,
    userPool: auth.userPool,
    knowledgeBase: knowledge.knowledgeBase,
    backendDir: opts.backendDir,
  });
  const frontend = new FrontendStack(app, 'Pmbok-Frontend', {
    ...common,
    description: 'PMBOK Assistant: CloudFront + SPA + Cognito client',
    userPool: auth.userPool,
    cognitoDomainHost: auth.domainHost,
    oktaProvider: auth.oktaProvider,
    apiFunction: api.fn,
    apiFunctionUrl: api.functionUrl,
    siteAssetsDir: opts.siteAssetsDir,
  });
  // Explicit (also implied by references) so `cdk deploy --all` ordering is obvious.
  knowledge.addStackDependency(data);
  api.addStackDependency(knowledge);
  frontend.addStackDependency(api);

  Tags.of(app).add('project', 'pmbok-assistant');
  Tags.of(app).add('env', config.stage);
  Tags.of(app).add('owner', config.owner);

  const placeholders = findPlaceholders(config);
  if (placeholders.length > 0) {
    const msg = `Config still has placeholder values (CHANGE-ME): ${placeholders.join(', ')}. Set them in infra/cdk.json before deploying.`;
    Annotations.of(ops).addWarningV2('pmbok:config-placeholder', msg);
  }

  return { ops, auth, data, knowledge, api, frontend };
}

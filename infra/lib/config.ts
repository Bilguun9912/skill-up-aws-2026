/**
 * Typed + validated app configuration, read from CDK context.
 *
 * Defaults live in `cdk.json` → `context`. Override any key with `-c key=value`
 * (objects/arrays as JSON, e.g. `-c 'budget={"monthlyLimitUsd":50,...}'`).
 *
 * Values containing `CHANGE-ME` are placeholders: synth succeeds but prints a
 * warning. Replace them before `cdk deploy` (see docs/deploy.md).
 */

export const PLACEHOLDER_MARKER = 'CHANGE-ME';

export interface OktaConfig {
  /** Okta issuer URL, e.g. https://<org>.okta.com (or .../oauth2/default) */
  issuerUrl: string;
  /** Okta OIDC app client id (not secret) */
  clientId: string;
  /** Name of the Secrets Manager secret holding the Okta client secret (plain string value) */
  clientSecretName: string;
}

export interface BudgetConfig {
  monthlyLimitUsd: number;
  alertThresholdsUsd: number[];
  email: string;
}

export const MODEL_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

export interface AppConfig {
  stage: string;
  region: string;
  /** Optional explicit account (otherwise CDK_DEFAULT_ACCOUNT, otherwise env-agnostic) */
  account?: string;
  /** Tag value for `owner` */
  owner: string;
  /** Bedrock inference profile id (confirm via `aws bedrock list-inference-profiles`) */
  modelId: string;
  /** Model used for follow-up query rewriting; defaults to modelId */
  queryRewriteModelId: string;
  /** Claude effort level passed to the backend as MODEL_EFFORT */
  modelEffort: ModelEffort;
  embeddingModelId: string;
  embeddingDimensions: number;
  dailyQuestionLimit: number;
  maxOutputTokens: number;
  historyTurns: number;
  retrieveTopK: number;
  budget: BudgetConfig;
  /** Globally unique Cognito domain prefix */
  cognitoDomainPrefix: string;
  okta?: OktaConfig;
  localDevOrigins: string[];
  reservedConcurrency?: number;
  /**
   * Use an inline stub instead of bundling ../backend (tests, or when backend
   * isn't written yet). Never deploy with this on.
   */
  apiCodeStub: boolean;
}

/** Minimal interface so this module can be used without a CDK App (unit tests). */
export interface ContextSource {
  tryGetContext(key: string): unknown;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`Invalid CDK config: ${message}`);
    this.name = 'ConfigError';
  }
}

/** Context values given via `-c` arrive as strings; parse JSON-looking ones. */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('{') || t.startsWith('[') || t === 'true' || t === 'false' || t === 'null') {
    try {
      return JSON.parse(t);
    } catch {
      throw new ConfigError(`could not parse JSON context value: ${value}`);
    }
  }
  return value;
}

function str(node: ContextSource, key: string, required = true): string | undefined {
  const v = parseMaybeJson(node.tryGetContext(key));
  if (v === undefined || v === null || v === '') {
    if (required) throw new ConfigError(`"${key}" is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ConfigError(`"${key}" must be a string`);
  return v;
}

function num(raw: unknown, key: string, opts: { min?: number; max?: number; int?: boolean } = {}): number {
  const v = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ConfigError(`"${key}" must be a number`);
  if (opts.int && !Number.isInteger(v)) throw new ConfigError(`"${key}" must be an integer`);
  if (opts.min !== undefined && v < opts.min) throw new ConfigError(`"${key}" must be >= ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) throw new ConfigError(`"${key}" must be <= ${opts.max}`);
  return v;
}

function bool(raw: unknown, key: string, dflt: boolean): boolean {
  const v = parseMaybeJson(raw);
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v !== 'boolean') throw new ConfigError(`"${key}" must be true/false`);
  return v;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const STAGE_RE = /^[a-z][a-z0-9-]{0,15}$/;
// Cognito prefix: lowercase letters, numbers, hyphens; can't start/end with hyphen; no reserved words.
const DOMAIN_PREFIX_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function loadConfig(node: ContextSource): AppConfig {
  const stage = str(node, 'stage')!;
  if (!STAGE_RE.test(stage)) throw new ConfigError(`"stage" must match ${STAGE_RE}`);

  const region = str(node, 'region')!;
  if (!REGION_RE.test(region)) throw new ConfigError(`"region" looks invalid: ${region}`);

  const account = str(node, 'account', false);
  if (account !== undefined && !/^\d{12}$/.test(account)) throw new ConfigError('"account" must be 12 digits');

  const owner = str(node, 'owner', false) ?? 'pmbok-poc';
  const modelId = str(node, 'modelId')!;
  const queryRewriteModelId = str(node, 'queryRewriteModelId', false) ?? modelId;
  const modelEffort = (str(node, 'modelEffort', false) ?? 'low') as ModelEffort;
  if (!MODEL_EFFORTS.includes(modelEffort)) {
    throw new ConfigError(`"modelEffort" must be one of ${MODEL_EFFORTS.join('|')}`);
  }
  const embeddingModelId = str(node, 'embeddingModelId')!;
  const embeddingDimensions = num(node.tryGetContext('embeddingDimensions'), 'embeddingDimensions', {
    int: true,
    min: 1,
    max: 4096,
  });
  if (embeddingModelId.startsWith('amazon.titan-embed-text-v2') && ![256, 512, 1024].includes(embeddingDimensions)) {
    throw new ConfigError('Titan Text Embeddings v2 supports 256, 512 or 1024 dimensions');
  }

  const dailyQuestionLimit = num(node.tryGetContext('dailyQuestionLimit'), 'dailyQuestionLimit', { int: true, min: 1 });
  const maxOutputTokens = num(node.tryGetContext('maxOutputTokens'), 'maxOutputTokens', { int: true, min: 1 });
  const historyTurns = num(node.tryGetContext('historyTurns') ?? 5, 'historyTurns', { int: true, min: 0, max: 50 });
  const retrieveTopK = num(node.tryGetContext('retrieveTopK') ?? 6, 'retrieveTopK', { int: true, min: 1, max: 100 });

  // budget
  const rawBudget = parseMaybeJson(node.tryGetContext('budget'));
  if (!rawBudget || typeof rawBudget !== 'object' || Array.isArray(rawBudget)) {
    throw new ConfigError('"budget" must be an object');
  }
  const b = rawBudget as Record<string, unknown>;
  const monthlyLimitUsd = num(b.monthlyLimitUsd, 'budget.monthlyLimitUsd', { min: 1 });
  const rawThresholds = parseMaybeJson(b.alertThresholdsUsd);
  if (!Array.isArray(rawThresholds) || rawThresholds.length === 0) {
    throw new ConfigError('"budget.alertThresholdsUsd" must be a non-empty array');
  }
  const alertThresholdsUsd = rawThresholds.map((t, i) => num(t, `budget.alertThresholdsUsd[${i}]`, { min: 0.01 }));
  if (new Set(alertThresholdsUsd).size !== alertThresholdsUsd.length) {
    throw new ConfigError('"budget.alertThresholdsUsd" must not contain duplicates');
  }
  if (alertThresholdsUsd.length > 10) throw new ConfigError('"budget.alertThresholdsUsd" max 10 entries');
  const email = typeof b.email === 'string' ? b.email : '';
  if (!EMAIL_RE.test(email)) throw new ConfigError('"budget.email" must be an email address');

  // cognito
  const cognitoDomainPrefix = str(node, 'cognitoDomainPrefix')!;
  if (!DOMAIN_PREFIX_RE.test(cognitoDomainPrefix) || /aws|amazon|cognito/.test(cognitoDomainPrefix)) {
    throw new ConfigError(
      '"cognitoDomainPrefix" must be lowercase letters/numbers/hyphens (max 63) and must not contain aws/amazon/cognito',
    );
  }

  // okta (optional)
  let okta: OktaConfig | undefined;
  const rawOkta = parseMaybeJson(node.tryGetContext('okta'));
  if (rawOkta !== undefined && rawOkta !== null) {
    if (typeof rawOkta !== 'object' || Array.isArray(rawOkta)) throw new ConfigError('"okta" must be an object');
    const o = rawOkta as Record<string, unknown>;
    for (const k of ['issuerUrl', 'clientId', 'clientSecretName']) {
      if (typeof o[k] !== 'string' || (o[k] as string) === '') throw new ConfigError(`"okta.${k}" is required`);
    }
    if (!/^https:\/\//.test(o.issuerUrl as string)) throw new ConfigError('"okta.issuerUrl" must start with https://');
    okta = {
      issuerUrl: (o.issuerUrl as string).replace(/\/+$/, ''),
      clientId: o.clientId as string,
      clientSecretName: o.clientSecretName as string,
    };
  }

  const rawOrigins = parseMaybeJson(node.tryGetContext('localDevOrigins')) ?? [];
  if (!Array.isArray(rawOrigins) || rawOrigins.some((x) => typeof x !== 'string')) {
    throw new ConfigError('"localDevOrigins" must be an array of strings');
  }
  const localDevOrigins = (rawOrigins as string[]).map((o) => o.replace(/\/+$/, ''));
  for (const o of localDevOrigins) {
    if (!/^https?:\/\/[^/]+$/.test(o)) throw new ConfigError(`"localDevOrigins" entry must be an origin: ${o}`);
  }

  const rawReserved = parseMaybeJson(node.tryGetContext('reservedConcurrency'));
  const reservedConcurrency =
    rawReserved === undefined || rawReserved === null || rawReserved === ''
      ? undefined
      : num(rawReserved, 'reservedConcurrency', { int: true, min: 1 });

  const apiCodeStub = bool(node.tryGetContext('apiCodeStub'), 'apiCodeStub', false);

  return {
    stage,
    region,
    account,
    owner,
    modelId,
    queryRewriteModelId,
    modelEffort,
    embeddingModelId,
    embeddingDimensions,
    dailyQuestionLimit,
    maxOutputTokens,
    historyTurns,
    retrieveTopK,
    budget: { monthlyLimitUsd, alertThresholdsUsd, email },
    cognitoDomainPrefix,
    okta,
    localDevOrigins,
    reservedConcurrency,
    apiCodeStub,
  };
}

/** Returns the config keys that still hold placeholder values. */
export function findPlaceholders(config: AppConfig): string[] {
  const out: string[] = [];
  const check = (key: string, v: string | undefined) => {
    if (v && v.includes(PLACEHOLDER_MARKER)) out.push(key);
  };
  check('modelId', config.modelId);
  check('queryRewriteModelId', config.queryRewriteModelId);
  check('budget.email', config.budget.email);
  check('cognitoDomainPrefix', config.cognitoDomainPrefix.toUpperCase());
  return out;
}

/** SSM parameter holding the User Pool Client id (ADR-006). Deterministic — no CFN reference. */
export function clientIdParamName(stage: string): string {
  return `/pmbok/${stage}/cognito/client-id`;
}

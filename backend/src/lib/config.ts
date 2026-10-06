import { z } from 'zod';

const intFromEnv = (def: number, min = 1, max = 100_000) =>
  z.coerce.number().int().min(min).max(max).default(def);

const EnvSchema = z.object({
  TABLE_NAME: z.string().min(1),
  KNOWLEDGE_BASE_ID: z.string().min(1),
  MODEL_ID: z.string().min(1),
  USER_POOL_ID: z.string().min(1),
  CLIENT_ID_PARAM: z.string().min(1),
  DAILY_QUESTION_LIMIT: intFromEnv(30),
  MAX_OUTPUT_TOKENS: intFromEnv(2000, 1, 128_000),
  HISTORY_TURNS: intFromEnv(5, 0, 50),
  RETRIEVE_TOP_K: intFromEnv(6, 1, 100),
  /**
   * Claude effort sent via additionalModelRequestFields (Anthropic models only).
   * `off` disables sending model-specific fields entirely.
   */
  MODEL_EFFORT: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim().toLowerCase() : 'low'))
    .pipe(z.enum(['off', 'low', 'medium', 'high', 'xhigh', 'max'])),
  /** Optional: model for the JA→EN search-query rewrite. Falls back to MODEL_ID. */
  QUERY_REWRITE_MODEL_ID: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined)),
});

export interface AppConfig {
  tableName: string;
  knowledgeBaseId: string;
  modelId: string;
  userPoolId: string;
  clientIdParam: string;
  dailyQuestionLimit: number;
  maxOutputTokens: number;
  historyTurns: number;
  retrieveTopK: number;
  queryRewriteModelId: string;
  modelEffort: ModelEffort;
}

export type ModelEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

let cached: AppConfig | undefined;

/** Reads and validates env vars once per container. */
export function getConfig(): AppConfig {
  if (cached) return cached;
  const env = EnvSchema.parse(process.env);
  cached = {
    tableName: env.TABLE_NAME,
    knowledgeBaseId: env.KNOWLEDGE_BASE_ID,
    modelId: env.MODEL_ID,
    userPoolId: env.USER_POOL_ID,
    clientIdParam: env.CLIENT_ID_PARAM,
    dailyQuestionLimit: env.DAILY_QUESTION_LIMIT,
    maxOutputTokens: env.MAX_OUTPUT_TOKENS,
    historyTurns: env.HISTORY_TURNS,
    retrieveTopK: env.RETRIEVE_TOP_K,
    queryRewriteModelId: env.QUERY_REWRITE_MODEL_ID ?? env.MODEL_ID,
    modelEffort: env.MODEL_EFFORT,
  };
  return cached;
}

/** Test helper. */
export function resetConfigForTests(): void {
  cached = undefined;
}

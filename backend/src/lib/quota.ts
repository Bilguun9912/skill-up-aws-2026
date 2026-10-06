import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './aws.js';
import { getConfig } from './config.js';
import { quotaExceeded } from './http.js';
import { usageSk, userPk } from './keys.js';
import type { Usage } from './types.js';

export const USAGE_TTL_DAYS = 35;
const TZ = 'Asia/Tokyo';

/** YYYY-MM-DD in Asia/Tokyo. */
export function tokyoDate(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Epoch seconds, now + 35 days. */
export function usageTtl(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000) + USAGE_TTL_DAYS * 24 * 60 * 60;
}

function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof Error && err.name === 'ConditionalCheckFailedException';
}

/**
 * Atomically consumes one question from today's quota.
 * `ADD count 1` guarded by `attribute_not_exists(count) OR count < :limit`; condition failure ⇒ 429.
 */
export async function consumeQuestion(sub: string, now: Date = new Date()): Promise<{ date: string; count: number }> {
  const { tableName, dailyQuestionLimit } = getConfig();
  const date = tokyoDate(now);
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { PK: userPk(sub), SK: usageSk(date) },
        UpdateExpression: 'ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)',
        ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
        ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':limit': dailyQuestionLimit, ':ttl': usageTtl(now) },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    return { date, count: Number(res.Attributes?.count ?? 0) };
  } catch (err) {
    if (isConditionalCheckFailed(err)) throw quotaExceeded();
    throw err;
  }
}

/** Adds token usage to today's Usage item (best effort; caller logs failures). */
export async function recordTokenUsage(sub: string, usage: Usage, now: Date = new Date()): Promise<void> {
  const { tableName } = getConfig();
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { PK: userPk(sub), SK: usageSk(tokyoDate(now)) },
      UpdateExpression: 'ADD inputTokens :in, outputTokens :out SET #ttl = if_not_exists(#ttl, :ttl)',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':in': usage.inputTokens,
        ':out': usage.outputTokens,
        ':ttl': usageTtl(now),
      },
    }),
  );
}

export async function getUsage(sub: string, now: Date = new Date()) {
  const { tableName, dailyQuestionLimit } = getConfig();
  const date = tokyoDate(now);
  const res = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { PK: userPk(sub), SK: usageSk(date) } }),
  );
  return { date, count: Number(res.Item?.count ?? 0), limit: dailyQuestionLimit };
}

import {
  BatchWriteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from './aws.js';
import { getConfig } from './config.js';
import {
  MESSAGE_SK_PREFIX,
  SESSION_SK_PREFIX,
  messageSk,
  messagesPk,
  sessionSk,
  userPk,
} from './keys.js';
import type { Citation, Usage } from './types.js';

export interface SessionRecord {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export type Role = 'user' | 'assistant';

export interface MessageRecord {
  messageId: string;
  role: Role;
  content: string;
  citations?: Citation[];
  usage?: Usage;
  createdAt: string;
}

const table = () => getConfig().tableName;

function toSession(item: Record<string, unknown>): SessionRecord {
  return {
    sessionId: String(item.sessionId),
    title: String(item.title ?? ''),
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
  };
}

function toMessage(item: Record<string, unknown>): MessageRecord {
  const m: MessageRecord = {
    messageId: String(item.messageId),
    role: item.role === 'assistant' ? 'assistant' : 'user',
    content: String(item.content ?? ''),
    createdAt: String(item.createdAt),
  };
  if (Array.isArray(item.citations)) m.citations = item.citations as Citation[];
  if (item.usage && typeof item.usage === 'object') m.usage = item.usage as Usage;
  return m;
}

async function queryAll(input: QueryCommandInput): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey }));
    items.push(...((res.Items ?? []) as Record<string, unknown>[]));
    ExclusiveStartKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return items;
}

// ---------- sessions ----------

export async function getSession(sub: string, sessionId: string): Promise<SessionRecord | undefined> {
  const res = await ddb.send(
    new GetCommand({ TableName: table(), Key: { PK: userPk(sub), SK: sessionSk(sessionId) } }),
  );
  return res.Item ? toSession(res.Item) : undefined;
}

/** All sessions of the caller, newest first (sorted by updatedAt). */
export async function listSessions(sub: string): Promise<SessionRecord[]> {
  const items = await queryAll({
    TableName: table(),
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': userPk(sub), ':prefix': SESSION_SK_PREFIX },
    ProjectionExpression: 'sessionId, title, createdAt, updatedAt',
  });
  return items.map(toSession).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Messages of a session, oldest first. */
export async function listMessages(sub: string, sessionId: string): Promise<MessageRecord[]> {
  const items = await queryAll({
    TableName: table(),
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': messagesPk(sub, sessionId), ':prefix': MESSAGE_SK_PREFIX },
    ScanIndexForward: true,
  });
  return items.map(toMessage);
}

/** Last `limit` messages (for prompt history), returned oldest first. */
export async function getRecentMessages(
  sub: string,
  sessionId: string,
  limit: number,
): Promise<MessageRecord[]> {
  if (limit <= 0) return [];
  const res = await ddb.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': messagesPk(sub, sessionId), ':prefix': MESSAGE_SK_PREFIX },
      ProjectionExpression: 'messageId, #role, content, createdAt',
      ExpressionAttributeNames: { '#role': 'role' },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return ((res.Items ?? []) as Record<string, unknown>[]).map(toMessage).reverse();
}

/** Deletes the session item and all its messages. Returns false if the session doesn't exist. */
export async function deleteSession(sub: string, sessionId: string): Promise<boolean> {
  const session = await getSession(sub, sessionId);
  if (!session) return false;

  const msgKeys = await queryAll({
    TableName: table(),
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': messagesPk(sub, sessionId), ':prefix': MESSAGE_SK_PREFIX },
    ProjectionExpression: 'PK, SK',
  });
  const keys = [...msgKeys.map((k) => ({ PK: k.PK, SK: k.SK })), { PK: userPk(sub), SK: sessionSk(sessionId) }];

  for (let i = 0; i < keys.length; i += 25) {
    let requests: NonNullable<ConstructorParameters<typeof BatchWriteCommand>[0]['RequestItems']>[string] =
      keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
    for (let attempt = 0; requests.length > 0; attempt++) {
      if (attempt > 5) throw new Error('BatchWrite delete did not complete');
      if (attempt > 0) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [table()]: requests } }));
      requests = res.UnprocessedItems?.[table()] ?? [];
    }
  }
  return true;
}

// ---------- chat turn persistence ----------

export interface SaveTurnInput {
  sub: string;
  sessionId: string;
  /** Present when this turn creates the session. */
  newSession?: { title: string; createdAt: string };
  userMessage: { messageId: string; content: string; createdAt: string };
  assistantMessage: {
    messageId: string;
    content: string;
    citations: Citation[];
    usage: Usage;
    createdAt: string;
  };
}

/**
 * Atomically writes the user + assistant messages and creates the session (first message)
 * or bumps its updatedAt.
 */
export async function saveTurn(input: SaveTurnInput): Promise<void> {
  const { sub, sessionId, userMessage: u, assistantMessage: a } = input;
  const TableName = table();
  const pk = messagesPk(sub, sessionId);

  const sessionOp = input.newSession
    ? {
        Put: {
          TableName,
          Item: {
            PK: userPk(sub),
            SK: sessionSk(sessionId),
            sessionId,
            title: input.newSession.title,
            createdAt: input.newSession.createdAt,
            updatedAt: a.createdAt,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      }
    : {
        Update: {
          TableName,
          Key: { PK: userPk(sub), SK: sessionSk(sessionId) },
          UpdateExpression: 'SET updatedAt = :u',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':u': a.createdAt },
        },
      };

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        sessionOp,
        {
          Put: {
            TableName,
            Item: {
              PK: pk,
              SK: messageSk(u.createdAt, u.messageId),
              messageId: u.messageId,
              role: 'user',
              content: u.content,
              createdAt: u.createdAt,
            },
          },
        },
        {
          Put: {
            TableName,
            Item: {
              PK: pk,
              SK: messageSk(a.createdAt, a.messageId),
              messageId: a.messageId,
              role: 'assistant',
              content: a.content,
              citations: a.citations,
              usage: a.usage,
              createdAt: a.createdAt,
            },
          },
        },
      ],
    }),
  );
}

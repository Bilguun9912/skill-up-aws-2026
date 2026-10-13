/**
 * Local dev server: runs the real api handler (src/handlers/api.ts) on http://localhost:3001.
 *
 *   BEDROCK_MODE=fake (default) → canned answers + sample retrieval, no AWS calls at all
 *   BEDROCK_MODE=real           → real Bedrock with your local AWS credentials
 *                                 (MODEL_ID required; KNOWLEDGE_BASE_ID optional — fake retrieval if unset)
 *
 * DynamoDB: DynamoDB Local (docker-compose.local.yml) on DYNAMODB_ENDPOINT (default http://localhost:8000).
 *
 * Auth: no Cognito. This server mints RS256 access tokens with a key generated at startup
 * (GET /local/token) and preloads that key into the real aws-jwt-verify verifier, so the
 * production auth code path runs unchanged. Tokens are useless anywhere else.
 * Dev-only: this file is never bundled into the Lambda (entry is src/handlers/api.ts).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { LambdaFunctionURLEvent } from 'aws-lambda';

const PORT = Number(process.env.PORT ?? 3001);
const MODE = (process.env.BEDROCK_MODE ?? 'fake').toLowerCase();
if (MODE !== 'fake' && MODE !== 'real') {
  console.error(`BEDROCK_MODE must be "fake" or "real" (got "${MODE}")`);
  process.exit(1);
}

// ---------- env (must be set before importing backend modules: clients read it at creation) ----------
const POOL_ID = 'ap-northeast-1_LocalDev';
const CLIENT_ID = 'local-dev-client';
const env = process.env;
env.AWS_REGION ??= 'ap-northeast-1';
env.TABLE_NAME ??= 'PmbokLocal';
env.USER_POOL_ID = POOL_ID;
env.CLIENT_ID_PARAM = '/pmbok/local/cognito/client-id';
env.DAILY_QUESTION_LIMIT ??= '1000';
env.AWS_ENDPOINT_URL_DYNAMODB = env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
if (MODE === 'fake') {
  env.MODEL_ID ??= 'local.fake-model';
  env.KNOWLEDGE_BASE_ID ??= 'LOCALFAKEKB';
  // DynamoDB Local accepts any credentials; never use real ones in fake mode.
  env.AWS_ACCESS_KEY_ID = 'local';
  env.AWS_SECRET_ACCESS_KEY = 'local';
  delete env.AWS_SESSION_TOKEN;
  delete env.AWS_PROFILE;
} else {
  if (!env.MODEL_ID) {
    console.error('BEDROCK_MODE=real needs MODEL_ID (Bedrock inference profile id). See docs/local-dev.md');
    process.exit(1);
  }
  env.KNOWLEDGE_BASE_ID ??= 'LOCALFAKEKB';
}
const fakeRetrieve = env.KNOWLEDGE_BASE_ID === 'LOCALFAKEKB';

// ---------- awslambda runtime shim ----------
type Meta = { statusCode?: number; headers?: Record<string, string> };
(globalThis as unknown as { awslambda: unknown }).awslambda = {
  streamifyResponse: (fn: unknown) => fn,
  HttpResponseStream: {
    from(stream: Writable & { res?: ServerResponse }, meta: Meta) {
      stream.res?.writeHead(meta.statusCode ?? 200, meta.headers ?? {});
      return stream;
    },
  },
};

const { mockClient } = await import('aws-sdk-client-mock');
const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
mockClient(SSMClient).on(GetParameterCommand).resolves({ Parameter: { Value: CLIENT_ID } });

const fake = await import('./fakeBedrock.js');
if (MODE === 'fake') fake.installFakeLlm();
if (fakeRetrieve) fake.installFakeRetrieve();

const { handle } = await import('../src/handlers/api.js');
const { getVerifier } = await import('../src/lib/auth.js');
const { DynamoDBClient, CreateTableCommand, DescribeTableCommand } = await import('@aws-sdk/client-dynamodb');

// ---------- local JWT issuer ----------
const KID = 'local-dev-key';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: KID, alg: 'RS256', use: 'sig' }] };
(await getVerifier()).cacheJwks(jwks as never);

const LOCAL_SUB = 'local-user-0000';
function mintToken(): { accessToken: string; expiresAt: number; username: string } {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600;
  const b64 = (v: string | Buffer) => Buffer.from(v).toString('base64url');
  const payload = {
    sub: LOCAL_SUB,
    username: 'local-user',
    token_use: 'access',
    client_id: CLIENT_ID,
    iss: `https://cognito-idp.${env.AWS_REGION}.amazonaws.com/${POOL_ID}`,
    iat: now,
    exp,
    jti: randomUUID(),
    scope: 'openid email profile',
  };
  const input = `${b64(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }))}.${b64(JSON.stringify(payload))}`;
  const sig = createSign('RSA-SHA256').update(input).sign(privateKey);
  return { accessToken: `${input}.${b64(sig)}`, expiresAt: exp * 1000, username: 'local-user' };
}

// ---------- DynamoDB Local table ----------
async function ensureTable(): Promise<void> {
  const client = new DynamoDBClient({});
  const TableName = env.TABLE_NAME!;
  for (let attempt = 1; ; attempt++) {
    try {
      await client.send(new DescribeTableCommand({ TableName }));
      return;
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'ResourceNotFoundException') {
        await client.send(
          new CreateTableCommand({
            TableName,
            BillingMode: 'PAY_PER_REQUEST',
            AttributeDefinitions: [
              { AttributeName: 'PK', AttributeType: 'S' },
              { AttributeName: 'SK', AttributeType: 'S' },
            ],
            KeySchema: [
              { AttributeName: 'PK', KeyType: 'HASH' },
              { AttributeName: 'SK', KeyType: 'RANGE' },
            ],
          }),
        );
        console.log(`created DynamoDB Local table ${TableName}`);
        return;
      }
      if (attempt >= 20) {
        throw new Error(`DynamoDB Local not reachable at ${env.AWS_ENDPOINT_URL_DYNAMODB} — is docker compose up? (${name})`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

// ---------- HTTP adapter (Node request → Function URL v2 event) ----------
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function toEvent(req: IncomingMessage, body: string): LambdaFunctionURLEvent {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: url.pathname,
    rawQueryString: url.search.replace(/^\?/, ''),
    headers,
    body: body || undefined,
    isBase64Encoded: false,
    requestContext: { http: { method: req.method ?? 'GET', path: url.pathname } },
  } as unknown as LambdaFunctionURLEvent;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';

  if (path === '/local/token' && req.method === 'GET') return json(res, 200, mintToken());
  if (path === '/config.json') {
    // Served to the Vite dev server (proxied) in local mode; dummy Cognito values are never used.
    return json(res, 200, {
      region: env.AWS_REGION,
      userPoolId: POOL_ID,
      clientId: CLIENT_ID,
      cognitoDomain: 'localhost',
      localDev: true,
    });
  }
  if (!path.startsWith('/api/')) return json(res, 404, { error: { code: 'not_found', message: 'Not found' } });

  const body = await readBody(req);
  const stream = Object.assign(
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (!res.headersSent) res.writeHead(200);
        if (chunk.length === 0) return cb();
        res.write(chunk, (err) => cb(err ?? null));
      },
      final(cb) {
        if (!res.headersSent) res.writeHead(200);
        res.end();
        cb();
      },
    }),
    { res },
  );
  await handle(toEvent(req, body), stream as never);
  if (!res.writableEnded) {
    if (!res.headersSent) res.writeHead(200);
    res.end();
  }
}

await ensureTable();
createServer((req, res) => {
  onRequest(req, res).catch((err) => {
    console.error('local server error', err);
    if (!res.headersSent) json(res, 500, { error: { code: 'internal', message: 'local server error' } });
    else res.end();
  });
}).listen(PORT, () => {
  console.log(
    `PMBOK local api on http://localhost:${PORT}  (bedrock=${MODE}, retrieval=${fakeRetrieve ? 'fake' : 'real KB ' + env.KNOWLEDGE_BASE_ID}, model=${env.MODEL_ID})`,
  );
});

import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { LambdaFunctionURLEvent } from 'aws-lambda';

/** Captures what the handler writes to the Lambda response stream. */
export class CaptureStream extends Writable {
  metadata?: awslambda.HttpResponseMetadata;
  chunks: Buffer[] = [];
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    cb();
  }
  get text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
  get status(): number | undefined {
    return this.metadata?.statusCode;
  }
  json(): any {
    return JSON.parse(this.text);
  }
  ndjson(): any[] {
    return this.text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }
}

export function makeEvent(opts: {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  base64?: boolean;
}): LambdaFunctionURLEvent {
  const raw = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  const method = opts.method ?? 'GET';
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: opts.path,
    rawQueryString: '',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    requestContext: {
      accountId: 'anonymous',
      apiId: 'test',
      domainName: 'test.lambda-url.ap-northeast-1.on.aws',
      domainPrefix: 'test',
      http: { method, path: opts.path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'vitest' },
      requestId: randomUUID(),
      routeKey: '$default',
      stage: '$default',
      time: '06/Oct/2026:00:00:00 +0000',
      timeEpoch: 0,
    },
    body: raw === undefined ? undefined : opts.base64 ? Buffer.from(raw, 'utf8').toString('base64') : raw,
    isBase64Encoded: Boolean(opts.base64 && raw !== undefined),
  } as LambdaFunctionURLEvent;
}

// ---------- JWT helpers (real RS256 signatures; verified offline via cached JWKS) ----------

export const TEST_CLIENT_ID = 'test-client-id';
export const TEST_POOL_ID = 'ap-northeast-1_TestPool';
const ISSUER = `https://cognito-idp.ap-northeast-1.amazonaws.com/${TEST_POOL_ID}`;
const KID = 'test-kid';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const TEST_JWKS = {
  keys: [{ ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: KID, alg: 'RS256', use: 'sig' }],
};

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signToken(claims: Record<string, unknown> = {}, signWith = privateKey): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: 'user-sub-1',
    username: 'alice',
    token_use: 'access',
    client_id: TEST_CLIENT_ID,
    iss: ISSUER,
    iat: now,
    exp: now + 3600,
    scope: 'openid',
    ...claims,
  };
  const header = { alg: 'RS256', kid: KID, typ: 'JWT' };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createSign('RSA-SHA256').update(input).sign(signWith);
  return `${input}.${b64url(sig)}`;
}

export function otherPrivateKey() {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
}

/** Async iterable that mimics a ConverseStream `stream`. */
export async function* converseStreamEvents(texts: string[], usage = { inputTokens: 1200, outputTokens: 80 }) {
  yield { messageStart: { role: 'assistant' } };
  for (const t of texts) yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: t } } };
  yield { contentBlockStop: { contentBlockIndex: 0 } };
  yield { messageStop: { stopReason: 'end_turn' } };
  yield { metadata: { usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens }, metrics: { latencyMs: 10 } } };
}

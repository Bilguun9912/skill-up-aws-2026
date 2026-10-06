import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { ssm } from './aws.js';
import { getConfig } from './config.js';
import { unauthorized } from './http.js';
import { log, errFields } from './log.js';
import type { AuthUser } from './types.js';

type AccessVerifier = ReturnType<typeof createVerifier>;

function createVerifier(userPoolId: string, clientId: string) {
  return CognitoJwtVerifier.create({ userPoolId, tokenUse: 'access', clientId });
}

let verifierPromise: Promise<AccessVerifier> | undefined;

/**
 * The User Pool Client lives in the Frontend stack, so the client id is read from SSM
 * (param name in CLIENT_ID_PARAM) at cold start and cached per container (ADR-006).
 */
async function loadVerifier(): Promise<AccessVerifier> {
  const cfg = getConfig();
  const res = await ssm.send(new GetParameterCommand({ Name: cfg.clientIdParam }));
  const clientId = res.Parameter?.Value;
  if (!clientId) throw new Error('Cognito client id parameter is empty');
  return createVerifier(cfg.userPoolId, clientId);
}

export function getVerifier(): Promise<AccessVerifier> {
  if (!verifierPromise) {
    verifierPromise = loadVerifier().catch((err) => {
      verifierPromise = undefined; // retry on next request
      throw err;
    });
  }
  return verifierPromise;
}

/** Test helper. */
export function resetAuthForTests(): void {
  verifierPromise = undefined;
}

/**
 * Verifies the Cognito access token from `x-auth-token` (signature, issuer, token_use=access,
 * client_id, expiry). Throws HttpError 401 on any failure. Never logs the token.
 */
export async function authenticate(headers: Record<string, string | undefined>): Promise<AuthUser> {
  const raw = headers['x-auth-token'];
  const token = raw?.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw unauthorized('Missing token');

  const verifier = await getVerifier(); // SSM failure => 500 (config problem, not the caller's fault)
  try {
    const payload = await verifier.verify(token);
    const username = typeof payload.username === 'string' ? payload.username : payload.sub;
    return { sub: payload.sub, username };
  } catch (err) {
    log.info('auth.rejected', { errName: errFields(err).errName });
    throw unauthorized('Invalid token');
  }
}

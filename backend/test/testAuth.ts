import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { getVerifier } from '../src/lib/auth.js';
import { TEST_CLIENT_ID, TEST_JWKS } from './helpers.js';

/** Mocks SSM (client id param) and preloads the test JWKS into the real aws-jwt-verify verifier. */
export const ssmMock = mockClient(SSMClient);

export async function primeAuth(): Promise<void> {
  ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: TEST_CLIENT_ID } });
  const verifier = await getVerifier();
  verifier.cacheJwks(TEST_JWKS as never);
}

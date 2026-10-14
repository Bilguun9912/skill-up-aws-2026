import { describe, expect, it } from 'vitest';
import { parseConfig } from './config';

const base = {
  region: 'ap-northeast-1',
  userPoolId: 'ap-northeast-1_X',
  clientId: 'abc',
  cognitoDomain: 'https://p.auth.ap-northeast-1.amazoncognito.com/',
};

describe('parseConfig', () => {
  it('normalises cognitoDomain to a bare host', () => {
    expect(parseConfig(base).cognitoDomain).toBe('p.auth.ap-northeast-1.amazoncognito.com');
  });

  it('has no localDev flag unless set', () => {
    expect(parseConfig(base).localDev).toBeUndefined();
  });

  it('honours localDev=true in dev builds only', () => {
    // vitest runs with import.meta.env.DEV = true; production builds compile this branch away.
    expect(parseConfig({ ...base, localDev: true }).localDev).toBe(import.meta.env.DEV ? true : undefined);
    expect(parseConfig({ ...base, localDev: 'yes' }).localDev).toBeUndefined();
  });

  it('rejects missing keys', () => {
    expect(() => parseConfig({ ...base, clientId: '' })).toThrow(/clientId/);
  });
});

describe('identityProvider', () => {
  it('is passed through when set and sent to Cognito as identity_provider', async () => {
    const cfg = parseConfig({ ...base, identityProvider: ' Okta ' });
    expect(cfg.identityProvider).toBe('Okta');
    const { buildOidcSettings } = await import('./auth/oidc');
    expect(buildOidcSettings(cfg).extraQueryParams).toEqual({ identity_provider: 'Okta' });
    expect(buildOidcSettings(parseConfig(base)).extraQueryParams).toBeUndefined();
  });
});

describe('signUpDomains', () => {
  it('passes through a string array, ignores anything else', () => {
    expect(parseConfig({ ...base, signUpDomains: ['example.co.jp'] }).signUpDomains).toEqual(['example.co.jp']);
    expect(parseConfig({ ...base, signUpDomains: 'example.co.jp' }).signUpDomains).toBeUndefined();
    expect(parseConfig({ ...base, signUpDomains: [] }).signUpDomains).toBeUndefined();
  });
});

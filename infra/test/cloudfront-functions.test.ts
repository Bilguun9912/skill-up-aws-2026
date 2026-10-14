import { Template } from 'aws-cdk-lib/assertions';
import { normaliseIpv4Cidr } from '../lib/config';
import { BLOCKED_HEADER, buildViewerRequestCode } from '../lib/cloudfront-functions';
import { makeApp } from './helpers';

// Documentation-only ranges (RFC 5737). Never put real company IPs in this public repo.
const ALLOWED = ['203.0.113.10/32', '198.51.100.0/24'];

type Handler = (event: unknown) => any;
function load(code: string): Handler {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${code}\nreturn handler;`)() as Handler;
}
const ev = (ip: string, uri = '/') => ({ viewer: { ip }, request: { uri, method: 'GET', headers: {} } });

describe('viewer-request function', () => {
  const withSpa = load(buildViewerRequestCode({ allowedIpCidrs: ALLOWED, spaRewrite: true }));
  const apiOnly = load(buildViewerRequestCode({ allowedIpCidrs: ALLOWED, spaRewrite: false }));

  test.each([
    ['203.0.113.10', true],
    ['203.0.113.11', false],
    ['198.51.100.0', true],
    ['198.51.100.255', true],
    ['198.51.101.1', false],
    ['10.0.0.1', false],
    ['2001:db8::1', false],
    ['', false],
    ['999.1.1.1', false],
  ])('ip %s allowed=%s', (ip, allowed) => {
    const res = apiOnly(ev(ip, '/api/me'));
    if (allowed) {
      expect(res.uri).toBe('/api/me');
    } else {
      expect(res.statusCode).toBe(403);
      expect(res.headers[BLOCKED_HEADER].value).toBe('ip');
    }
  });

  test('SPA rewrite for allowed viewers, never for /api', () => {
    expect(withSpa(ev('203.0.113.10', '/chat/123')).uri).toBe('/index.html');
    expect(withSpa(ev('203.0.113.10', '/assets/app.js')).uri).toBe('/assets/app.js');
    expect(withSpa(ev('203.0.113.10', '/api/me')).uri).toBe('/api/me');
    expect(withSpa(ev('8.8.8.8', '/')).statusCode).toBe(403);
  });

  test('no allowlist → no IP check', () => {
    const open = load(buildViewerRequestCode({ allowedIpCidrs: [], spaRewrite: true }));
    expect(open(ev('8.8.8.8', '/x')).uri).toBe('/index.html');
  });
});

describe('allowedIpCidrs config', () => {
  test('normalises bare IPs and validates', () => {
    expect(normaliseIpv4Cidr(' 203.0.113.10 ')).toBe('203.0.113.10/32');
    expect(normaliseIpv4Cidr('198.51.100.0/24')).toBe('198.51.100.0/24');
    expect(() => normaliseIpv4Cidr('256.1.1.1')).toThrow();
    expect(() => normaliseIpv4Cidr('1.2.3.4/33')).toThrow();
    expect(() => normaliseIpv4Cidr('2001:db8::1')).toThrow();
  });

  test('allowlist attaches to both behaviors and disables IPv6', () => {
    const { stacks } = makeApp({ allowedIpCidrs: ALLOWED });
    const t = Template.fromStack(stacks.frontend);
    t.resourceCountIs('AWS::CloudFront::Function', 2);
    const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0] as any;
    const cfg = dist.Properties.DistributionConfig;
    expect(cfg.IPV6Enabled).toBe(false);
    expect(cfg.DefaultCacheBehavior.FunctionAssociations).toHaveLength(1);
    expect(cfg.CacheBehaviors[0].PathPattern).toBe('/api/*');
    expect(cfg.CacheBehaviors[0].FunctionAssociations).toHaveLength(1);
  });

  test('without allowlist: IPv6 on, no /api function', () => {
    const { stacks } = makeApp({ allowPublicAccess: true });
    const t = Template.fromStack(stacks.frontend);
    t.resourceCountIs('AWS::CloudFront::Function', 1);
  });

  test('strictConfig refuses an open site unless allowPublicAccess', () => {
    const ready = { modelId: 'global.anthropic.test', budget: { monthlyLimitUsd: 100, alertThresholdsUsd: [10], email: 'a@example.com' }, cognitoDomainPrefix: 'pmbok-test-prefix' };
    expect(() => makeApp({ ...ready, strictConfig: true })).toThrow(/allowedIpCidrs is empty/);
    expect(() => makeApp({ ...ready, strictConfig: true, allowPublicAccess: true })).not.toThrow();
    expect(() => makeApp({ ...ready, strictConfig: true, allowedIpCidrs: ALLOWED })).not.toThrow();
  });
});

describe('config.json identityProvider', () => {
  const okta = { okta: { issuerUrl: 'https://example.okta.com', clientId: 'abc', clientSecretName: 'pmbok/okta-client-secret' } };
  // config.json is zipped into an asset; deploy-time values appear as SourceMarkers.
  const markers = (t: Template) => {
    const dep = Object.values(t.findResources('Custom::CDKBucketDeployment'))[0] as any;
    return JSON.stringify(dep.Properties.SourceMarkers);
  };
  test('set to the Okta provider name when Okta is configured', () => {
    const { stacks } = makeApp({ ...okta, allowPublicAccess: true });
    expect(markers(Template.fromStack(stacks.frontend))).toContain('OktaIdp');
  });
  test('absent without Okta', () => {
    const { stacks } = makeApp({ allowPublicAccess: true });
    expect(markers(Template.fromStack(stacks.frontend))).not.toContain('OktaIdp');
  });
});

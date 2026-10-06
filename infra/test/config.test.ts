import { ConfigError, findPlaceholders, loadConfig, clientIdParamName } from '../lib/config';
import { cdkJsonContext, contextSource } from './helpers';

const load = (over: Record<string, unknown> = {}) => loadConfig(contextSource({ ...cdkJsonContext(), ...over }));

describe('config', () => {
  test('cdk.json defaults load and match docs', () => {
    const c = load();
    expect(c.stage).toBe('dev');
    expect(c.region).toBe('ap-northeast-1');
    expect(c.embeddingModelId).toBe('amazon.titan-embed-text-v2:0');
    expect(c.embeddingDimensions).toBe(1024);
    expect(c.dailyQuestionLimit).toBe(30);
    expect(c.maxOutputTokens).toBe(2000);
    expect(c.budget).toEqual({ monthlyLimitUsd: 100, alertThresholdsUsd: [10, 30, 60], email: expect.any(String) });
    expect(c.localDevOrigins).toEqual(['http://localhost:5173']);
    expect(c.okta).toBeUndefined();
    expect(c.reservedConcurrency).toBeUndefined();
    expect(c.apiCodeStub).toBe(false);
    expect(c.modelEffort).toBe('low');
  });

  test('placeholders are detected', () => {
    expect(findPlaceholders(load())).toEqual(['modelId', 'queryRewriteModelId', 'budget.email', 'cognitoDomainPrefix']);
    const real = load({
      modelId: 'jp.anthropic.claude-x',
      budget: { monthlyLimitUsd: 100, alertThresholdsUsd: [10], email: 'a@b.co' },
      cognitoDomainPrefix: 'pmbok-assistant-123',
    });
    expect(findPlaceholders(real)).toEqual([]);
  });

  test('queryRewriteModelId defaults to modelId, can be overridden', () => {
    expect(load({ modelId: 'jp.x' }).queryRewriteModelId).toBe('jp.x');
    expect(load({ modelId: 'jp.x', queryRewriteModelId: 'jp.y' }).queryRewriteModelId).toBe('jp.y');
  });

  test('string context values (-c) are coerced', () => {
    const c = load({
      dailyQuestionLimit: '10',
      budget: '{"monthlyLimitUsd":"50","alertThresholdsUsd":[5,"20"],"email":"x@y.jp"}',
      localDevOrigins: '["http://localhost:3000/"]',
      okta: '{"issuerUrl":"https://org.okta.com/","clientId":"abc","clientSecretName":"pmbok/okta"}',
      reservedConcurrency: '5',
      apiCodeStub: 'true',
    });
    expect(c.dailyQuestionLimit).toBe(10);
    expect(c.budget.alertThresholdsUsd).toEqual([5, 20]);
    expect(c.localDevOrigins).toEqual(['http://localhost:3000']);
    expect(c.okta).toEqual({ issuerUrl: 'https://org.okta.com', clientId: 'abc', clientSecretName: 'pmbok/okta' });
    expect(c.reservedConcurrency).toBe(5);
    expect(c.apiCodeStub).toBe(true);
  });

  test.each([
    [{ budget: { monthlyLimitUsd: 100, alertThresholdsUsd: [10], email: 'nope' } }],
    [{ budget: { monthlyLimitUsd: 100, alertThresholdsUsd: [], email: 'a@b.co' } }],
    [{ cognitoDomainPrefix: 'My_Prefix' }],
    [{ cognitoDomainPrefix: 'pmbok-cognito' }],
    [{ embeddingDimensions: 768 }],
    [{ region: 'tokyo' }],
    [{ modelId: '' }],
    [{ okta: { issuerUrl: 'http://insecure', clientId: 'a', clientSecretName: 's' } }],
    [{ okta: { issuerUrl: 'https://x.okta.com', clientId: 'a' } }],
    [{ localDevOrigins: ['http://localhost:5173/path'] }],
    [{ account: '123' }],
    [{ modelEffort: 'extreme' }],
  ])('rejects invalid config %j', (over) => {
    expect(() => load(over)).toThrow(ConfigError);
  });

  test('client id param name', () => {
    expect(clientIdParamName('dev')).toBe('/pmbok/dev/cognito/client-id');
  });
});

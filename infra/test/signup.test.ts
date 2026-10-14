import { Template } from 'aws-cdk-lib/assertions';
import { PRE_SIGN_UP_CODE } from '../lib/stacks/auth-stack';
import { makeApp } from './helpers';

// Example domain only — never put the real company domain in this public repo.
const DOMAIN = 'example.co.jp';

function trigger(allowed: string) {
  const mod: { exports: { handler?: (e: unknown) => Promise<unknown> } } = { exports: {} };
  const env = { ALLOWED_EMAIL_DOMAINS: allowed };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('exports', 'process', PRE_SIGN_UP_CODE)(mod.exports, { env });
  return mod.exports.handler!;
}
const ev = (email: string, triggerSource = 'PreSignUp_SignUp') => ({
  triggerSource,
  request: { userAttributes: { email } },
  response: { autoConfirmUser: false, autoVerifyEmail: false },
});

describe('pre sign-up domain check', () => {
  const handler = trigger(DOMAIN);

  test.each([
    ['taro@example.co.jp', true],
    ['Taro.Yamada@EXAMPLE.CO.JP', true],
    ['  hanako@example.co.jp ', true],
    ['taro@gmail.com', false],
    ['taro@example.co.jp.evil.com', false],
    ['taro@sub.example.co.jp', false],
    ['taro@notexample.co.jp', false],
    ['example.co.jp', false],
    ['', false],
  ])('%s allowed=%s', async (email, allowed) => {
    if (allowed) {
      const out: any = await handler(ev(email));
      expect(out.response.autoConfirmUser).toBe(false); // still needs the email code
    } else {
      await expect(handler(ev(email))).rejects.toThrow(/company email/);
    }
  });

  test('admin-created and federated users are not blocked', async () => {
    await expect(handler(ev('partner@gmail.com', 'PreSignUp_AdminCreateUser'))).resolves.toBeTruthy();
    await expect(handler(ev('x@gmail.com', 'PreSignUp_ExternalProvider'))).resolves.toBeTruthy();
  });

  test('empty allow-list rejects everyone', async () => {
    await expect(trigger('')(ev('taro@example.co.jp'))).rejects.toThrow();
  });
});

describe('user pool sign-up config', () => {
  test('self sign-up off by default (admin-only)', () => {
    const { stacks } = makeApp({ allowPublicAccess: true });
    const t = Template.fromStack(stacks.auth);
    t.hasResourceProperties('AWS::Cognito::UserPool', { AdminCreateUserConfig: { AllowAdminCreateUserOnly: true } });
    t.resourceCountIs('AWS::Lambda::Function', 0);
  });

  test('allowedEmailDomains → self sign-up with pre sign-up trigger and email verification', () => {
    const { stacks } = makeApp({ allowPublicAccess: true, allowedEmailDomains: ['@Example.co.jp'] });
    const t = Template.fromStack(stacks.auth);
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      AutoVerifiedAttributes: ['email'],
      LambdaConfig: { PreSignUp: {} },
    });
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: { ALLOWED_EMAIL_DOMAINS: 'example.co.jp' } },
    });
  });

  test('rejects invalid domains', () => {
    expect(() => makeApp({ allowedEmailDomains: ['not a domain'] })).toThrow(/allowedEmailDomains/);
  });
});

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { GithubOidcStack } from '../lib/stacks/github-oidc-stack';
import { makeApp } from './helpers';

function synth(createOidcProvider: boolean) {
  const app = new App();
  const stack = new GithubOidcStack(app, 'Pmbok-GithubOidc', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
    githubRepo: 'owner/repo',
    githubEnvironment: 'dev',
    createOidcProvider,
  });
  return Template.fromStack(stack);
}

describe('GithubOidcStack', () => {
  test('creates the OIDC provider and a role trusted only by the repo environment', () => {
    const t = synth(true);
    t.resourceCountIs('AWS::IAM::OIDCProvider', 1);
    t.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub': 'repo:owner/repo:environment:dev',
              },
            },
          }),
        ],
      },
    });
  });

  test('role may only assume CDK bootstrap roles (no direct resource permissions)', () => {
    const t = synth(true);
    const policies = t.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
    const actions = statements.flatMap((s: any) => ([] as string[]).concat(s.Action));
    expect(actions.sort()).toEqual(['cloudformation:DescribeStacks', 'sts:AssumeRole', 'sts:TagSession'].sort());
    const assume = statements.find((s: any) => ([] as string[]).concat(s.Action).includes('sts:AssumeRole'));
    expect(assume.Condition.StringEquals['iam:ResourceTag/aws-cdk:bootstrap-role']).toEqual(
      expect.arrayContaining(['deploy', 'file-publishing', 'lookup']),
    );
  });

  test('can reuse an existing provider', () => {
    synth(false).resourceCountIs('AWS::IAM::OIDCProvider', 0);
  });
});

describe('strictConfig', () => {
  test('placeholders fail synth when strictConfig=true', () => {
    expect(() => makeApp({ strictConfig: true })).toThrow(/CHANGE-ME/);
  });

  test('placeholders only warn by default', () => {
    expect(() => makeApp()).not.toThrow();
  });
});

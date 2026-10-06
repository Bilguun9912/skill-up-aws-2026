import { Aws, CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface GithubOidcStackProps extends StackProps {
  /** "owner/repo" */
  githubRepo: string;
  /** GitHub Actions environment the deploy job runs in (trust is scoped to it). */
  githubEnvironment: string;
  /**
   * The GitHub OIDC provider can exist only once per account. Set false if the
   * account already has `token.actions.githubusercontent.com` registered.
   */
  createOidcProvider: boolean;
}

const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';

/**
 * Lets GitHub Actions deploy with short-lived credentials (no access keys).
 *
 * Deployed ONCE from a laptop with admin credentials, outside `--all`:
 *   npx cdk deploy Pmbok-GithubOidc -c githubOidc=true
 *
 * The role can only assume the CDK bootstrap roles (deploy / file-publishing /
 * lookup); CloudFormation's execution role does the actual resource changes.
 */
export class GithubOidcStack extends Stack {
  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

    const providerArn = props.createOidcProvider
      ? new iam.OidcProviderNative(this, 'GithubOidcProvider', {
          url: `https://${GITHUB_OIDC_HOST}`,
          clientIds: ['sts.amazonaws.com'],
        }).oidcProviderArn
      : `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:oidc-provider/${GITHUB_OIDC_HOST}`;

    const role = new iam.Role(this, 'GithubDeployRole', {
      description: `GitHub Actions deploy role for ${props.githubRepo} (environment ${props.githubEnvironment})`,
      assumedBy: new iam.WebIdentityPrincipal(providerArn, {
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com',
          [`${GITHUB_OIDC_HOST}:sub`]: `repo:${props.githubRepo}:environment:${props.githubEnvironment}`,
        },
      }),
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: [`arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/cdk-*`],
        conditions: {
          StringEquals: { 'iam:ResourceTag/aws-cdk:bootstrap-role': ['deploy', 'file-publishing', 'image-publishing', 'lookup'] },
        },
      }),
    );
    // Lets the workflow read stack outputs (smoke test / summary) without assuming CDK roles.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadPmbokStackOutputs',
        actions: ['cloudformation:DescribeStacks'],
        resources: [`arn:${Aws.PARTITION}:cloudformation:${Aws.REGION}:${Aws.ACCOUNT_ID}:stack/Pmbok-*/*`],
      }),
    );

    new CfnOutput(this, 'GithubDeployRoleArn', {
      value: role.roleArn,
      description: 'Set as GitHub variable AWS_DEPLOY_ROLE_ARN',
    });
  }
}

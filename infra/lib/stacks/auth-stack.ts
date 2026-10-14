import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack, StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { AppConfig } from '../config';

export interface AuthStackProps extends StackProps {
  config: AppConfig;
}

/**
 * Pre sign-up trigger (ADR-014): only emails in ALLOWED_EMAIL_DOMAINS may self sign up.
 * Exact domain match on the part after the last "@" (so "x@corp.jp.evil.com" and "x@sub.corp.jp" are rejected).
 * Admin-created users and federated (Okta) users are allowed through. Cognito then sends an email
 * verification code, so a user can't register a colleague's address without access to that mailbox.
 */
export const PRE_SIGN_UP_CODE = `
const ALLOWED = (process.env.ALLOWED_EMAIL_DOMAINS || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
exports.handler = async (event) => {
  if (event.triggerSource === 'PreSignUp_AdminCreateUser' || event.triggerSource === 'PreSignUp_ExternalProvider') {
    return event;
  }
  const email = String((event.request.userAttributes || {}).email || '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  const domain = at > 0 ? email.slice(at + 1) : '';
  if (!domain || ALLOWED.indexOf(domain) === -1) {
    throw new Error('Sign-up is limited to company email addresses. / 会社のメールアドレスでのみ登録できます。');
  }
  return event; // no auto-confirm: the user must enter the emailed verification code
};
`;

/**
 * Cognito User Pool + managed login domain + optional Okta OIDC IdP.
 * The User Pool *Client* lives in the Frontend stack (ADR-006).
 */
export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly domain: cognito.UserPoolDomain;
  /** Bare host: <prefix>.auth.<region>.amazoncognito.com */
  readonly domainHost: string;
  /** https://<domainHost> */
  readonly domainBaseUrl: string;
  readonly oktaProvider?: cognito.UserPoolIdentityProviderOidc;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { config } = props;

    const selfSignUp = config.allowedEmailDomains.length > 0;
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      // Self sign-up only when restricted to company domains (pre sign-up trigger below).
      selfSignUpEnabled: selfSignUp,
      signInAliases: { email: true },
      autoVerify: { email: true },
      // An email change only takes effect after the new address is verified.
      keepOriginal: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: false,
      },
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    if (selfSignUp) {
      const preSignUp = new lambda.Function(this, 'PreSignUpDomainCheck', {
        description: 'Cognito pre sign-up: allow only company email domains',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.handler',
        code: lambda.Code.fromInline(PRE_SIGN_UP_CODE),
        timeout: Duration.seconds(5),
        memorySize: 128,
        environment: { ALLOWED_EMAIL_DOMAINS: config.allowedEmailDomains.join(',') },
        logGroup: new logs.LogGroup(this, 'PreSignUpLogs', {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      });
      this.userPool.addTrigger(cognito.UserPoolOperation.PRE_SIGN_UP, preSignUp);
    }

    this.domain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: config.cognitoDomainPrefix },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    this.domainHost = `${config.cognitoDomainPrefix}.auth.${this.region}.amazoncognito.com`;
    this.domainBaseUrl = `https://${this.domainHost}`;

    if (config.okta) {
      this.oktaProvider = new cognito.UserPoolIdentityProviderOidc(this, 'OktaIdp', {
        userPool: this.userPool,
        name: 'Okta',
        clientId: config.okta.clientId,
        // CFN dynamic reference ({{resolve:secretsmanager:...}}) — the secret value never lands in the template.
        clientSecret: SecretValue.secretsManager(config.okta.clientSecretName).unsafeUnwrap(),
        issuerUrl: config.okta.issuerUrl,
        scopes: ['openid', 'email', 'profile'],
        attributeRequestMethod: cognito.OidcAttributeRequestMethod.GET,
        attributeMapping: {
          email: cognito.ProviderAttribute.other('email'),
        },
      });
    }

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'CognitoDomain', { value: this.domainBaseUrl });
    new CfnOutput(this, 'OktaRedirectUri', {
      value: `${this.domainBaseUrl}/oauth2/idpresponse`,
      description: 'Sign-in redirect URI to register in the Okta OIDC app',
    });
  }
}

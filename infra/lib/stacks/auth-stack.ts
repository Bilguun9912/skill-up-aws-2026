import { CfnOutput, RemovalPolicy, SecretValue, Stack, StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { AppConfig } from '../config';

export interface AuthStackProps extends StackProps {
  config: AppConfig;
}

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

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
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

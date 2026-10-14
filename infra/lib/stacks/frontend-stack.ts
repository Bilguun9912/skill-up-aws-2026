import * as fs from 'node:fs';
import * as path from 'node:path';
import { Annotations, CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { buildViewerRequestCode } from '../cloudfront-functions';
import { AppConfig, clientIdParamName } from '../config';

export interface FrontendStackProps extends StackProps {
  config: AppConfig;
  userPool: cognito.IUserPool;
  /** Bare host: <prefix>.auth.<region>.amazoncognito.com */
  cognitoDomainHost: string;
  oktaProvider?: cognito.UserPoolIdentityProviderOidc;
  apiFunction: lambda.IFunction;
  apiFunctionUrl: lambda.IFunctionUrl;
  /** Override for tests; defaults to ../frontend/dist */
  siteAssetsDir?: string;
}

export const FRONTEND_DIST = path.resolve(__dirname, '../../../frontend/dist');



/**
 * Site bucket + CloudFront (OAC to S3 and to the Lambda Function URL), the Cognito
 * User Pool Client (needs the CloudFront domain), SSM param with the client id (ADR-006),
 * and /config.json for the SPA (ADR-010).
 */
export class FrontendStack extends Stack {
  readonly distribution: cloudfront.Distribution;
  readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);
    const { config, userPool } = props;

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const ipRestricted = config.allowedIpCidrs.length > 0;
    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        buildViewerRequestCode({ allowedIpCidrs: config.allowedIpCidrs, spaRewrite: true }),
      ),
      comment: ipRestricted ? 'IP allowlist + SPA routing' : 'SPA routing: extension-less paths to /index.html',
    });
    const apiIpCheck = ipRestricted
      ? new cloudfront.Function(this, 'ApiIpAllowlist', {
          runtime: cloudfront.FunctionRuntime.JS_2_0,
          code: cloudfront.FunctionCode.fromInline(
            buildViewerRequestCode({ allowedIpCidrs: config.allowedIpCidrs, spaRewrite: false }),
          ),
          comment: 'IP allowlist for /api/*',
        })
      : undefined;

    // /api/* → Lambda URL (OAC): AWS's documented pattern is the managed AllViewerExceptHostHeader
    // policy. A custom allow-list can't name `x-amz-content-sha256` (CloudFront rejects x-amz-*
    // headers in policies), yet the viewer's body hash must reach the OAC signer for POST/PUT.
    // Host is dropped (the Function URL needs its own); OAC overwrites Authorization with SigV4.
    const apiOriginRequestPolicy = cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER;

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `PMBOK Assistant (${config.stage})`,
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // The allowlist is IPv4-only (company egress IPs). With IPv6 on, dual-stack clients would
      // connect over IPv6 and be blocked, so IPv6 is turned off while the allowlist is active.
      enableIpv6: !ipRestricted,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(props.apiFunctionUrl, {
            readTimeout: Duration.seconds(60),
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: apiOriginRequestPolicy,
          compress: false, // don't buffer/alter the NDJSON stream
          functionAssociations: apiIpCheck
            ? [{ function: apiIpCheck, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }]
            : undefined,
        },
      },
      // NOTE: intentionally no errorResponses — they'd apply to /api/* too.
    });

    // FunctionUrlOrigin.withOriginAccessControl adds lambda:InvokeFunctionUrl for this distribution.
    // Function URLs created since Oct 2025 also require lambda:InvokeFunction (via function URL).
    new lambda.CfnPermission(this, 'ApiInvokeFunctionFromCloudFront', {
      action: 'lambda:InvokeFunction',
      principal: 'cloudfront.amazonaws.com',
      functionName: props.apiFunction.functionArn,
      sourceArn: `arn:${this.partition}:cloudfront::${this.account}:distribution/${this.distribution.distributionId}`,
      invokedViaFunctionUrl: true,
    });

    // --- Cognito User Pool Client (ADR-006) --------------------------------
    const siteOrigin = `https://${this.distribution.distributionDomainName}`;
    const origins_ = [siteOrigin, ...config.localDevOrigins];
    // The SPA uses `<origin>/` as both redirect_uri and post_logout_redirect_uri.
    const appUrls = origins_.map((o) => `${o}/`);

    const supportedIdentityProviders = [cognito.UserPoolClientIdentityProvider.COGNITO];
    if (props.oktaProvider) {
      supportedIdentityProviders.push(cognito.UserPoolClientIdentityProvider.custom(props.oktaProvider.providerName));
    }

    this.userPoolClient = new cognito.UserPoolClient(this, 'WebClient', {
      userPool,
      generateSecret: false,
      preventUserExistenceErrors: true,
      authFlows: {},
      supportedIdentityProviders,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: appUrls,
        logoutUrls: appUrls,
      },
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(7),
      enableTokenRevocation: true,
    });
    // Only refresh-token auth: sign-in happens via managed login (OAuth code + PKCE), not SRP/password APIs.
    (this.userPoolClient.node.defaultChild as cognito.CfnUserPoolClient).explicitAuthFlows = ['ALLOW_REFRESH_TOKEN_AUTH'];
    if (props.oktaProvider) {
      this.userPoolClient.node.addDependency(props.oktaProvider);
    }

    // Newer managed login requires a branding style per client; use Cognito defaults.
    new cognito.CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      userPoolId: userPool.userPoolId,
      clientId: this.userPoolClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    new ssm.StringParameter(this, 'ClientIdParam', {
      parameterName: clientIdParamName(config.stage),
      stringValue: this.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client id for the PMBOK SPA (read by the api Lambda)',
    });

    // --- Site deployment + runtime config (ADR-010) -----------------------
    const assetsDir = props.siteAssetsDir ?? FRONTEND_DIST;
    const sources: s3deploy.ISource[] = [];
    if (fs.existsSync(path.join(assetsDir, 'index.html'))) {
      sources.push(s3deploy.Source.asset(assetsDir));
    } else {
      const msg = `Frontend build not found at ${assetsDir} — deploying only config.json. Run "npm run build" in frontend/ first.`;
      Annotations.of(this).addWarningV2('pmbok:frontend-dist-missing', msg);
    }
    sources.push(
      s3deploy.Source.jsonData('config.json', {
        region: this.region,
        userPoolId: userPool.userPoolId,
        clientId: this.userPoolClient.userPoolClientId,
        cognitoDomain: props.cognitoDomainHost, // bare host, no scheme
        // With Okta configured, the SPA skips the Cognito page and goes straight to Okta.
        ...(props.oktaProvider ? { identityProvider: props.oktaProvider.providerName } : {}),
        // Self sign-up hint on the login screen (ADR-014). Generated at deploy, never committed.
        ...(config.allowedEmailDomains.length > 0 ? { signUpDomains: config.allowedEmailDomains } : {}),
      }),
    );

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources,
      destinationBucket: siteBucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      prune: true,
      // Revalidate on every request (ETag → cheap 304s); fine for a 10-user POC.
      cacheControl: [s3deploy.CacheControl.noCache()],
      memoryLimit: 512,
    });

    new CfnOutput(this, 'CloudFrontUrl', { value: siteOrigin });
    new CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
  }
}

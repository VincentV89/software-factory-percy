import * as fs from 'node:fs';
import * as path from 'node:path';
import { Duration, SecretValue, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import type { InstanceConfig } from '../config';
import { LAMBDA_RUNTIME_REASON, REPO_ROOT, logBucket, removal } from '../constructs';
import { suppress } from '../nag';
import type { ContactSgStack } from './contactsg-stack';
import { webAclRules } from './edgewaf-stack';
import type { EngineStack } from './engine-stack';
import { names, type FoundationStack } from './foundation-stack';

export interface EdgeProps extends StackProps {
  cfg: InstanceConfig;
  foundation: FoundationStack;
  contactsg: ContactSgStack;
  engine: EngineStack;
  cloudFrontWebAclArn: string;
}

/** Content-Security-Policy with no inline script (NFR-SEC-06). S3 is allowed for presigned CSV uploads. */
export const SPA_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://*.amazonaws.com",
  "form-action 'self' https://*.amazoncognito.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

/**
 * Edge: percy-cp and percy-dp REST APIs (regional WAF, throttles), the SPA bucket, CloudFront with
 * security headers and the CloudFront WAF, the Cognito app client and the late-bound names.
 */
export class EdgeStack extends Stack {
  readonly distribution: cloudfront.Distribution;
  readonly cpApi: apigw.RestApi;
  readonly dpApi: apigw.RestApi;

  constructor(scope: Construct, id: string, props: EdgeProps) {
    super(scope, id, props);
    const { cfg, foundation: f, contactsg: c, engine: e } = props;
    const n = names(cfg);
    const accessLogs = logBucket(this, 'AccessLogs', cfg, { objectWriter: true });
    // Import functions into this stack so API Gateway invoke permissions live here, not in the
    // producing stacks (which would make those stacks depend on Edge: a cycle).
    const local = (lid: string, fn: lambda.IFunction): lambda.IFunction => lambda.Function.fromFunctionAttributes(this, lid, { functionArn: fn.functionArn, sameEnvironment: true });

    const stageOptions = (apiName: string): apigw.StageOptions => ({
      stageName: 'live',
      throttlingRateLimit: cfg.apiThrottleRps,
      throttlingBurstLimit: cfg.apiThrottleRps * 2,
      tracingEnabled: true,
      loggingLevel: apigw.MethodLoggingLevel.ERROR,
      metricsEnabled: true,
      accessLogDestination: new apigw.LogGroupLogDestination(new logs.LogGroup(this, `${apiName}AccessLogs`, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: removal(cfg) })),
      accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields({ caller: false, httpMethod: true, ip: true, protocol: true, requestTime: true, resourcePath: true, responseLength: true, status: true, user: false }),
    });

    // ---- percy-cp ----
    this.cpApi = new apigw.RestApi(this, 'PercyCp', {
      restApiName: `percy-${cfg.instance}-cp`,
      endpointConfiguration: { types: [apigw.EndpointType.REGIONAL] },
      deployOptions: stageOptions('PercyCp'),
      cloudWatchRole: false,
      disableExecuteApiEndpoint: false,
    });
    const authorizer = new apigw.RequestAuthorizer(this, 'SessionAuthorizer', {
      handler: local('AuthorizerFn', f.authorizer),
      identitySources: [apigw.IdentitySource.header('Cookie')],
      resultsCacheTtl: Duration.seconds(0),
    });
    const errorTemplate = (code: string, message: string) => ({ 'application/json': JSON.stringify({ error: { code, message, details: [], requestId: '$context.requestId' } }) });
    this.cpApi.addGatewayResponse('Unauthorized', { type: apigw.ResponseType.UNAUTHORIZED, statusCode: '401', templates: errorTemplate('UNAUTHENTICATED', 'Sign-in required.') });
    this.cpApi.addGatewayResponse('AccessDenied', { type: apigw.ResponseType.ACCESS_DENIED, statusCode: '403', templates: errorTemplate('FORBIDDEN', 'You do not have permission to do this.') });
    this.cpApi.addGatewayResponse('Throttled', { type: apigw.ResponseType.THROTTLED, statusCode: '429', templates: errorTemplate('THROTTLED', 'Too many requests.') });

    const auth = this.cpApi.root.addResource('auth');
    const bff = new apigw.LambdaIntegration(local('BffFn', f.bff));
    auth.addResource('login').addMethod('GET', bff);
    auth.addResource('callback').addMethod('GET', bff);
    auth.addResource('logout').addMethod('POST', bff);
    const api = this.cpApi.root.addResource('api');
    const proxy = (resource: apigw.IResource, fn: lambda.IFunction, lid: string): void => {
      resource.addResource('{proxy+}').addMethod('ANY', new apigw.LambdaIntegration(local(lid, fn)), { authorizer, authorizationType: apigw.AuthorizationType.CUSTOM });
    };
    proxy(api.addResource('platform'), f.platformApi, 'PlatformApiFn');
    proxy(api.addResource('contacts'), c.api, 'ContactSgApiFn');
    const engineRes = api.addResource('engine');
    proxy(engineRes, e.engineApi, 'EngineApiFn');
    if (cfg.instance !== 'dev') {
      // The dev-only send-log export does not exist outside dev (U7): an explicit route answers 404.
      engineRes.addResource('test').addResource('{proxy+}').addMethod(
        'ANY',
        new apigw.MockIntegration({ requestTemplates: { 'application/json': '{"statusCode": 404}' }, integrationResponses: [{ statusCode: '404', responseTemplates: { 'application/json': '{"error":{"code":"NOT_FOUND","message":"Not found."}}' } }] }),
        { methodResponses: [{ statusCode: '404' }], authorizer, authorizationType: apigw.AuthorizationType.CUSTOM },
      );
    }

    // ---- percy-dp (no session) ----
    this.dpApi = new apigw.RestApi(this, 'PercyDp', {
      restApiName: `percy-${cfg.instance}-dp`,
      endpointConfiguration: { types: [apigw.EndpointType.REGIONAL] },
      deployOptions: stageOptions('PercyDp'),
      cloudWatchRole: false,
    });
    const unsub = this.dpApi.root.addResource('u').addResource('{token}');
    const unsubIntegration = new apigw.LambdaIntegration(local('UnsubscribeFn', e.unsubscribe));
    unsub.addMethod('GET', unsubIntegration);
    unsub.addMethod('POST', unsubIntegration);

    // ---- Regional WAF on both APIs ----
    const regionalAcl = new wafv2.CfnWebACL(this, 'RegionalAcl', {
      name: `percy-${cfg.instance}-regional`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      rules: webAclRules(cfg, `percy-${cfg.instance}-regional`, '/u/'),
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `percy-${cfg.instance}-regional`, sampledRequestsEnabled: true },
    });
    for (const [aid, restApi] of [['Cp', this.cpApi], ['Dp', this.dpApi]] as const) {
      new wafv2.CfnWebACLAssociation(this, `${aid}AclAssociation`, { resourceArn: restApi.deploymentStage.stageArn, webAclArn: regionalAcl.attrArn });
    }

    // ---- SPA bucket + CloudFront ----
    const spaBucket = new s3.Bucket(this, 'Spa', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: 'spa/',
      removalPolicy: removal(cfg),
      autoDeleteObjects: !cfg.retain,
    });
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `percy-${cfg.instance}-security-headers`,
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: SPA_CSP, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, preload: true, override: true },
        contentTypeOptions: { override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.SAME_ORIGIN, override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
      },
    });
    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline("function handler(event){var r=event.request;if(r.uri.indexOf('.')<0){r.uri='/index.html';}return r;}"),
    });
    const apiBehavior = (origin: cloudfront.IOrigin, policy: cloudfront.IResponseHeadersPolicy | undefined): cloudfront.BehaviorOptions => ({
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: policy,
    });
    const cpOrigin = new origins.RestApiOrigin(this.cpApi);
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `Percy ${cfg.instance}`,
      defaultRootObject: 'index.html',
      webAclId: props.cloudFrontWebAclArn,
      enableLogging: true,
      logBucket: accessLogs,
      logFilePrefix: 'cloudfront/',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(spaBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
        functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/api/*': apiBehavior(cpOrigin, headers),
        '/auth/*': apiBehavior(cpOrigin, headers),
        // percy-dp pages set their own strict CSP.
        '/u/*': apiBehavior(new origins.RestApiOrigin(this.dpApi), undefined),
      },
    });
    const spaDist = path.join(REPO_ROOT, 'apps/spa/dist');
    const spaSource = fs.existsSync(path.join(spaDist, 'index.html')) ? spaDist : path.join(REPO_ROOT, 'apps/infra/assets/spa-placeholder');
    new s3deploy.BucketDeployment(this, 'SpaDeployment', { sources: [s3deploy.Source.asset(spaSource)], destinationBucket: spaBucket, distribution: this.distribution, distributionPaths: ['/*'], memoryLimit: 512 });

    const baseUrl = `https://${this.distribution.distributionDomainName}`;
    new ssm.StringParameter(this, 'PublicBaseUrl', { parameterName: n.publicBaseUrlParam, stringValue: baseUrl, description: 'Public base URL of this Percy instance (read at runtime by name, ADR-12)' });

    // ---- Cognito app client (callback = distribution URL) + its secret for the BFF ----
    const client = new cognito.UserPoolClient(this, 'BffClient', {
      userPool: f.userPool,
      userPoolClientName: `percy-${cfg.instance}-bff`,
      generateSecret: true,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      oAuth: { flows: { authorizationCodeGrant: true }, scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL], callbackUrls: [`${baseUrl}/auth/callback`], logoutUrls: [`${baseUrl}/`] },
      idTokenValidity: Duration.minutes(15),
      accessTokenValidity: Duration.minutes(15),
      refreshTokenValidity: Duration.hours(8),
    });
    const clientSecret = new secrets.Secret(this, 'BffClientSecret', {
      secretName: n.cognitoClientSecret,
      encryptionKey: f.keys.platform,
      secretObjectValue: { clientId: SecretValue.unsafePlainText(client.userPoolClientId), clientSecret: client.userPoolClientSecret },
      removalPolicy: removal(cfg),
    });

    suppress(clientSecret, [{ id: 'AwsSolutions-SMG4', reason: 'The Cognito app client secret is rotated by replacing the app client; Secrets Manager rotation cannot rotate it.' }]);
    suppress(this.distribution, [
      { id: 'AwsSolutions-CFR1', reason: 'Officers and citizens may be anywhere; no geo restriction is required by the brief.' },
      { id: 'AwsSolutions-CFR4', reason: 'Dev uses the default *.cloudfront.net certificate, which CloudFront serves with TLSv1 compatibility; the minimum protocol applies once a custom domain is added.' },
    ]);
    for (const restApi of [this.cpApi, this.dpApi]) {
      suppress(restApi, [
        { id: 'AwsSolutions-APIG2', reason: 'Request bodies are validated with shared zod schemas inside each Lambda (design section 3).' },
        { id: 'AwsSolutions-COG4', reason: 'percy-cp uses the session REQUEST authorizer (ADR-02) instead of a Cognito authorizer; percy-dp is public by design (FR-UNS-04).' },
      ]);
    }
    suppress(this.cpApi.root.getResource('auth') as apigw.IResource, [{ id: 'AwsSolutions-APIG4', reason: 'The OIDC login, callback and logout endpoints run before a session exists.' }]);
    suppress(this.dpApi, [{ id: 'AwsSolutions-APIG4', reason: 'Unsubscribe needs no sign-in (FR-UNS-04); the signed token is the authorisation and WAF rate-limits it.' }]);
    suppress(this, [
      { id: 'AwsSolutions-IAM4', reason: 'CDK-provided custom resources (bucket deployment, auto-delete, app client secret lookup) use AWSLambdaBasicExecutionRole.', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'] },
      { id: 'AwsSolutions-IAM5', reason: 'CDK-provided custom resources (bucket deployment, Cognito DescribeUserPoolClient) need the wildcards CDK generates.' },
      { id: 'AwsSolutions-L1', reason: LAMBDA_RUNTIME_REASON },
    ]);
  }
}

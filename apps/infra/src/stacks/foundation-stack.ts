import { ArnFormat, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';
import type { InstanceConfig } from '../config';
import { LAMBDA_RUNTIME_REASON, PercyFunction, logBucket, outboxPipe, percyTable, removal, tagOwner } from '../constructs';
import { suppress } from '../nag';

export const names = (cfg: InstanceConfig) => ({
  publicBaseUrlParam: `/percy/${cfg.instance}/public-base-url`,
  cognitoClientSecret: `/percy/${cfg.instance}/cognito-client`,
  unsubscribeSecret: `/percy/${cfg.instance}/unsubscribe-hmac`,
  table: (n: string) => `percy-${cfg.instance}-${n}`,
});

/**
 * Foundation: the three context CMKs, Cognito, the Platform tables and Lambdas, the percy-domain
 * bus, the audit Firehose + append-only bucket and the alarm topic.
 */
export class FoundationStack extends Stack {
  readonly keys: { platform: kms.Key; contactsg: kms.Key; engine: kms.Key };
  readonly bus: events.EventBus;
  readonly alarmTopic: sns.Topic;
  readonly auditStream: firehose.CfnDeliveryStream;
  readonly auditBucket: s3.Bucket;
  readonly tenancyTable: dynamodb.Table;
  readonly userPool: cognito.UserPool;
  readonly userPoolDomain: cognito.UserPoolDomain;
  readonly unsubscribeSecret: secrets.Secret;
  readonly bff: PercyFunction;
  readonly authorizer: PercyFunction;
  readonly platformApi: PercyFunction;

  constructor(scope: Construct, id: string, cfg: InstanceConfig, props: StackProps) {
    super(scope, id, props);
    const n = names(cfg);
    const key = (ctx: string): kms.Key => new kms.Key(this, `${ctx}Key`, { alias: `alias/percy/${cfg.instance}/${ctx}`, enableKeyRotation: true, removalPolicy: removal(cfg), description: `Percy ${ctx} context key (${cfg.instance})` });
    this.keys = { platform: key('platform'), contactsg: key('contactsg'), engine: key('engine') };
    // Service principals that must use the Engine key: SES publishes to the encrypted topic, SNS delivers to encrypted SQS.
    this.keys.engine.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('ses.amazonaws.com'), new iam.ServicePrincipal('sns.amazonaws.com'), new iam.ServicePrincipal('events.amazonaws.com')],
        actions: ['kms:GenerateDataKey*', 'kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );
    for (const k of [this.keys.platform, this.keys.contactsg]) {
      k.addToResourcePolicy(
        new iam.PolicyStatement({
          principals: [new iam.ServicePrincipal('events.amazonaws.com'), new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
          actions: ['kms:GenerateDataKey*', 'kms:Decrypt'],
          resources: ['*'],
          conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
        }),
      );
    }

    this.unsubscribeSecret = new secrets.Secret(this, 'UnsubscribeHmac', {
      secretName: n.unsubscribeSecret,
      encryptionKey: this.keys.engine,
      generateSecretString: { secretStringTemplate: JSON.stringify({ current: 'k1' }), generateStringKey: 'k1', passwordLength: 64, excludePunctuation: true },
      removalPolicy: removal(cfg),
    });
    suppress(this.unsubscribeSecret, [{ id: 'AwsSolutions-SMG4', reason: 'The HMAC key rotates by adding a new kid and moving "current" (design 7.9); automatic rotation would invalidate links in flight.' }]);

    // ---- Cognito (behind the BFF) ----
    this.userPool = new cognito.UserPool(this, 'Officers', {
      userPoolName: `percy-${cfg.instance}-officers`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      passwordPolicy: { minLength: 14, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true, tempPasswordValidity: Duration.days(3) },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: removal(cfg),
      deletionProtection: cfg.retain,
    });
    this.userPoolDomain = this.userPool.addDomain('HostedUi', { cognitoDomain: { domainPrefix: `percy-${cfg.instance}-${this.account}`.slice(0, 63) } });
    suppress(this.userPool, [
      { id: 'AwsSolutions-COG2', reason: 'MFA is optional in dev so the Playwright E2E can sign in; TechPass replaces Cognito before production.' },
      { id: 'AwsSolutions-COG3', reason: 'Threat protection (advanced security) is a paid feature plan not needed for the dev instance with script-created officers.' },
      { id: 'AwsSolutions-COG8', reason: 'The Plus feature plan (threat protection) is not needed for the dev instance with script-created officers; TechPass replaces Cognito later.' },
    ]);

    // ---- Platform tables ----
    this.tenancyTable = percyTable(this, 'Tenancy', cfg, this.keys.platform, { tableName: n.table('platform-tenancy'), gsis: ['gsi1', 'gsi2'] });
    const sessions = percyTable(this, 'Sessions', cfg, this.keys.platform, { tableName: n.table('platform-sessions'), ttl: 'expiresAt' });
    const outbox = percyTable(this, 'PlatformOutbox', cfg, this.keys.platform, { tableName: n.table('platform-outbox'), ttl: 'expiresAt', stream: dynamodb.StreamViewType.NEW_IMAGE });

    // ---- Bus ----
    this.bus = new events.EventBus(this, 'DomainBus', { eventBusName: `percy-${cfg.instance}-domain` });
    outboxPipe(this, 'PlatformOutboxPipe', outbox, this.bus, this.keys.platform, 'platform');

    // ---- Audit: Firehose → append-only bucket (FR-AUD-02/03) ----
    const accessLogs = logBucket(this, 'AccessLogs', cfg);
    this.auditBucket = new s3.Bucket(this, 'AuditBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.keys.platform,
      bucketKeyEnabled: true,
      versioned: true,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: 'audit/',
      objectLockEnabled: cfg.instance === 'prod',
      objectLockDefaultRetention: cfg.instance === 'prod' ? s3.ObjectLockRetention.compliance(Duration.days(cfg.auditRetentionDays)) : undefined,
      lifecycleRules: [{ id: 'audit-retention', expiration: Duration.days(cfg.auditRetentionDays), noncurrentVersionExpiration: Duration.days(cfg.auditRetentionDays) }],
      // Audit is never auto-deleted: the deny-delete policy would block it, and cdk destroy still completes.
      removalPolicy: removal({ ...cfg, retain: true }),
    });
    this.auditBucket.addToResourcePolicy(
      new iam.PolicyStatement({ sid: 'DenyAuditDeletion', effect: iam.Effect.DENY, principals: [new iam.AnyPrincipal()], actions: ['s3:DeleteObject', 's3:DeleteObjectVersion', 's3:DeleteObject*', 's3:PutLifecycleConfiguration'], resources: [this.auditBucket.arnForObjects('*'), this.auditBucket.bucketArn] }),
    );
    const firehoseRole = new iam.Role(this, 'AuditFirehoseRole', { assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': this.account } } }) });
    tagOwner(firehoseRole, 'platform', 'async');
    firehoseRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:PutObject', 's3:AbortMultipartUpload', 's3:GetBucketLocation', 's3:ListBucket', 's3:ListBucketMultipartUploads'], resources: [this.auditBucket.bucketArn, this.auditBucket.arnForObjects('audit/*')] }));
    this.keys.platform.grantEncryptDecrypt(firehoseRole);
    this.auditStream = new firehose.CfnDeliveryStream(this, 'AuditStream', {
      deliveryStreamName: `percy-${cfg.instance}-audit`,
      deliveryStreamType: 'DirectPut',
      deliveryStreamEncryptionConfigurationInput: { keyType: 'CUSTOMER_MANAGED_CMK', keyArn: this.keys.platform.keyArn },
      extendedS3DestinationConfiguration: {
        bucketArn: this.auditBucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        prefix: 'audit/!{timestamp:yyyy/MM/dd}/',
        errorOutputPrefix: 'audit-errors/!{firehose:error-output-type}/',
        bufferingHints: { intervalInSeconds: 60, sizeInMBs: 5 },
        compressionFormat: 'GZIP',
        encryptionConfiguration: { kmsEncryptionConfig: { awskmsKeyArn: this.keys.platform.keyArn } },
      },
    });
    this.auditStream.node.addDependency(firehoseRole);
    suppress(firehoseRole, [{ id: 'AwsSolutions-IAM5', reason: 'Firehose writes date-partitioned objects under audit/*; KMS grant actions use the CDK-generated wildcard action set.' }]);

    this.alarmTopic = new sns.Topic(this, 'Alarms', { topicName: `percy-${cfg.instance}-alarms`, masterKey: this.keys.platform, enforceSSL: true });

    // ---- Platform Lambdas ----
    const platformEnv = {
      TENANCY_TABLE: this.tenancyTable.tableName,
      SESSIONS_TABLE: sessions.tableName,
      PLATFORM_OUTBOX_TABLE: outbox.tableName,
      AUDIT_STREAM: this.auditStream.ref,
      PUBLIC_BASE_URL_PARAM: n.publicBaseUrlParam,
    };
    const fn = (id: string, entry: string, description: string, extra: Record<string, string> = {}): PercyFunction =>
      new PercyFunction(this, id, { entry, context: 'platform', plane: 'cp', cfg, description, environment: { ...platformEnv, ...extra }, memorySize: 1024 });
    this.bff = fn('PlatformBff', 'packages/platform/src/handlers/bff.ts', 'BFF: OIDC code + PKCE, sessions', {
      COGNITO_DOMAIN_URL: this.userPoolDomain.baseUrl(),
      COGNITO_ISSUER: `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`,
      COGNITO_CLIENT_SECRET_ID: n.cognitoClientSecret,
    });
    this.authorizer = fn('PlatformAuthorizer', 'packages/platform/src/handlers/authorizer.ts', 'REQUEST authorizer: session, CSRF, live roles');
    this.platformApi = fn('PlatformApi', 'packages/platform/src/handlers/api.ts', 'Platform admin API');
    this.platformApi.addEnvironment('COGNITO_USER_POOL_ID', this.userPool.userPoolId);
    this.platformApi.addToRolePolicy(new iam.PolicyStatement({ actions: ['cognito-idp:AdminCreateUser'], resources: [this.userPool.userPoolArn] }));

    for (const f of [this.bff, this.authorizer, this.platformApi]) {
      this.grantAudit(f);
      sessions.grantReadWriteData(f);
      this.tenancyTable.grantReadData(f);
    }
    this.tenancyTable.grantReadWriteData(this.bff);
    this.tenancyTable.grantReadWriteData(this.platformApi);
    outbox.grantWriteData(this.platformApi);
    const paramArn = this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: n.publicBaseUrlParam.slice(1) });
    this.bff.addToRolePolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [paramArn] }));
    this.bff.addToRolePolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [this.formatArn({ service: 'secretsmanager', resource: 'secret', resourceName: `${n.cognitoClientSecret}-*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })] }));
    this.keys.platform.grantDecrypt(this.bff);

    suppress(this, [
      { id: 'AwsSolutions-IAM5', reason: 'CDK grant helpers add index/* wildcards on Platform tables and the KMS action wildcards; the BFF reads its client secret by name (suffix wildcard is the Secrets Manager ARN suffix).' },
      { id: 'AwsSolutions-IAM4', reason: 'Lambda roles use AWSLambdaBasicExecutionRole for log delivery; CDK-provided custom resources do the same.', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'] },
      { id: 'AwsSolutions-L1', reason: LAMBDA_RUNTIME_REASON },
    ]);
  }

  grantAudit(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'], resources: [this.auditStream.attrArn] }));
    this.keys.platform.grant(grantee, 'kms:GenerateDataKey', 'kms:Decrypt');
  }
}

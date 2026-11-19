import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as guardduty from 'aws-cdk-lib/aws-guardduty';
import * as iam from 'aws-cdk-lib/aws-iam';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { InstanceConfig } from '../config';
import { LAMBDA_RUNTIME_REASON, PercyFunction, busRule, logBucket, outboxPipe, percyQueue, percyTable, removal, tagOwner } from '../constructs';
import { suppress } from '../nag';
import { names, type FoundationStack } from './foundation-stack';

/** ContactSG: contacts, lists, imports with the GuardDuty scan gate, suppressions and freeze. */
export class ContactSgStack extends Stack {
  readonly contactsTable: dynamodb.Table;
  readonly suppressionsTable: dynamodb.Table;
  readonly snapshotsBucket: s3.Bucket;
  readonly freezeQueue: sqs.Queue;
  readonly internalFn: PercyFunction;
  readonly api: PercyFunction;
  readonly dlqs: sqs.Queue[] = [];

  constructor(scope: Construct, id: string, cfg: InstanceConfig, f: FoundationStack, props: StackProps) {
    super(scope, id, props);
    const n = names(cfg);
    const key = f.keys.contactsg;
    this.contactsTable = percyTable(this, 'Contacts', cfg, key, { tableName: n.table('contactsg-contacts'), gsis: ['gsi1'] });
    const imports = percyTable(this, 'Imports', cfg, key, { tableName: n.table('contactsg-imports') });
    this.suppressionsTable = percyTable(this, 'Suppressions', cfg, key, { tableName: n.table('contactsg-suppressions') });
    const freezes = percyTable(this, 'Freezes', cfg, key, { tableName: n.table('contactsg-freezes') });
    const outbox = percyTable(this, 'Outbox', cfg, key, { tableName: n.table('contactsg-outbox'), ttl: 'expiresAt', stream: dynamodb.StreamViewType.NEW_IMAGE });
    outboxPipe(this, 'OutboxPipe', outbox, f.bus, key, 'contactsg');

    const accessLogs = logBucket(this, 'AccessLogs', cfg);
    const uploads = new s3.Bucket(this, 'Uploads', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      bucketKeyEnabled: true,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      eventBridgeEnabled: true,
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: 'uploads/',
      cors: [{ allowedMethods: [s3.HttpMethods.POST], allowedOrigins: ['*'], allowedHeaders: ['*'], maxAge: 600 }],
      lifecycleRules: [
        { id: 'raw', prefix: 'raw/', expiration: Duration.days(2) },
        { id: 'chunks', prefix: 'chunks/', expiration: Duration.days(2) },
        { id: 'quarantine', prefix: 'quarantine/', expiration: Duration.days(1) },
      ],
      removalPolicy: removal(cfg),
      autoDeleteObjects: !cfg.retain,
    });
    this.snapshotsBucket = new s3.Bucket(this, 'Snapshots', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      bucketKeyEnabled: true,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: 'snapshots/',
      lifecycleRules: [{ id: 'snapshot-retention', expiration: Duration.days(cfg.snapshotRetentionDays) }],
      removalPolicy: removal(cfg),
      autoDeleteObjects: !cfg.retain,
    });

    // ---- GuardDuty Malware Protection for S3 (FR-CON-04) ----
    const gdRole = new iam.Role(this, 'MalwareProtectionRole', { assumedBy: new iam.ServicePrincipal('malware-protection-plan.guardduty.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': this.account } } }) });
    tagOwner(gdRole, 'contactsg', 'async');
    gdRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:GetObjectTagging', 's3:GetObjectVersionTagging', 's3:PutObjectTagging', 's3:PutObjectVersionTagging'], resources: [uploads.arnForObjects('raw/*')] }));
    gdRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:ListBucket', 's3:GetBucketNotification', 's3:PutBucketNotification', 's3:GetBucketLocation'], resources: [uploads.bucketArn] }));
    gdRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [uploads.arnForObjects('malware-protection-resource-validation-object')] }));
    gdRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:PutRule', 'events:DeleteRule', 'events:PutTargets', 'events:RemoveTargets', 'events:DescribeRule', 'events:ListTargetsByRule'],
        resources: [this.formatArn({ service: 'events', resource: 'rule', resourceName: 'DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*' })],
      }),
    );
    key.grant(gdRole, 'kms:Decrypt', 'kms:GenerateDataKey');
    const malwarePlan = new guardduty.CfnMalwareProtectionPlan(this, 'UploadsMalwareProtection', {
      role: gdRole.roleArn,
      protectedResource: { s3Bucket: { bucketName: uploads.bucketName, objectPrefixes: ['raw/'] } },
      actions: { tagging: { status: 'ENABLED' } },
    });
    // GuardDuty validates bucket access during creation, after the role's policy is attached.
    malwarePlan.node.addDependency(gdRole.node.findChild('DefaultPolicy'));
    suppress(gdRole, [{ id: 'AwsSolutions-IAM5', reason: 'GuardDuty scans every object under raw/ and manages its own DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3* rules (AWS-documented role policy).' }]);

    // ---- Queues ----
    const freeze = percyQueue(this, 'FreezeRequests', key, { queueName: `percy-${cfg.instance}-freeze-requests`, visibilityTimeout: Duration.minutes(16) });
    this.freezeQueue = freeze.queue;
    const suppressEvents = percyQueue(this, 'SuppressEvents', key, { queueName: `percy-${cfg.instance}-contactsg-suppress-events`, visibilityTimeout: Duration.minutes(6) });
    this.dlqs.push(freeze.dlq, suppressEvents.dlq);

    // ---- Lambdas ----
    const env: Record<string, string> = {
      CONTACTS_TABLE: this.contactsTable.tableName,
      IMPORTS_TABLE: imports.tableName,
      SUPPRESSIONS_TABLE: this.suppressionsTable.tableName,
      FREEZES_TABLE: freezes.tableName,
      CONTACTSG_OUTBOX_TABLE: outbox.tableName,
      UPLOADS_BUCKET: uploads.bucketName,
      SNAPSHOTS_BUCKET: this.snapshotsBucket.bucketName,
      FREEZE_QUEUE_URL: freeze.queue.queueUrl,
      AUDIT_STREAM: f.auditStream.ref,
    };
    const fn = (id: string, entry: string, plane: 'cp' | 'async', opts: { timeout?: Duration; memorySize?: number; description: string }): PercyFunction => {
      const created = new PercyFunction(this, id, { entry: `packages/contactsg/src/handlers/${entry}.ts`, context: 'contactsg', plane, cfg, environment: env, ...opts });
      f.grantAudit(created);
      return created;
    };
    this.api = fn('ContactSgApi', 'api', 'cp', { description: 'ContactSG API: lists, imports, counts', memorySize: 1024 });
    const scanResult = fn('ScanResult', 'scan-result', 'async', { description: 'S3 Object Created + GuardDuty scan result', timeout: Duration.minutes(5), memorySize: 1024 });
    const importSteps = fn('ImportSteps', 'import-steps', 'async', { description: 'Import state machine tasks', timeout: Duration.minutes(15), memorySize: 3008 });
    const freezeFn = fn('Freeze', 'freeze', 'async', { description: 'Audience freeze', timeout: Duration.minutes(15), memorySize: 2048 });
    if (cfg.instance === 'dev') {
      for (const reader of [this.api, freezeFn]) {
        reader.addToRolePolicy(new iam.PolicyStatement({ actions: ['ses:ListEmailIdentities'], resources: ['*'] }));
      }
    }
    const suppressFn = fn('Suppress', 'suppress', 'async', { description: 'Suppression writer and membership fan-out', timeout: Duration.minutes(1) });
    this.internalFn = fn('Internal', 'internal', 'cp', { description: 'List holds for the Engine control plane' });

    for (const x of [this.api, scanResult, importSteps, freezeFn, suppressFn, this.internalFn]) {
      this.contactsTable.grantReadWriteData(x);
      imports.grantReadWriteData(x);
      this.suppressionsTable.grantReadData(x);
    }
    this.suppressionsTable.grantReadWriteData(suppressFn);
    this.suppressionsTable.grantReadWriteData(this.api);
    for (const x of [importSteps, freezeFn, suppressFn, this.api]) outbox.grantWriteData(x);
    freezes.grantReadWriteData(freezeFn);
    uploads.grantReadWrite(this.api);
    uploads.grantReadWrite(scanResult);
    uploads.grantDelete(scanResult);
    uploads.grantReadWrite(importSteps);
    this.snapshotsBucket.grantReadWrite(freezeFn);
    this.snapshotsBucket.grantDelete(freezeFn);
    freeze.queue.grantSendMessages(freezeFn);
    freezeFn.addEventSource(new SqsEventSource(freeze.queue, { batchSize: 1, reportBatchItemFailures: true }));
    suppressFn.addEventSource(new SqsEventSource(suppressEvents.queue, { batchSize: 10, reportBatchItemFailures: true }));

    // Import state machine: Validate → Map(chunks, 20) → Summarise; any failure → Fail (FR-CON-05/06).
    const invoke = (id: string, payload: Record<string, unknown>, resultPath: string) =>
      new tasks.LambdaInvoke(this, id, { lambdaFunction: importSteps, payload: sfn.TaskInput.fromObject(payload), payloadResponseOnly: true, resultPath, retryOnServiceExceptions: true });
    const failTask = invoke('MarkFailed', { step: 'fail', 'ref.$': '$.ref' }, sfn.JsonPath.DISCARD);
    const validate = invoke('Validate', { step: 'validate', 'ref.$': '$.ref' }, '$.validation');
    const chunkMap = new sfn.Map(this, 'ImportChunks', { itemsPath: '$.validation.chunkKeys', maxConcurrency: 20, itemSelector: { 'ref.$': '$.ref', 'chunkKey.$': '$$.Map.Item.Value' }, resultPath: '$.results' });
    chunkMap.itemProcessor(new tasks.LambdaInvoke(this, 'ImportChunk', { lambdaFunction: importSteps, payload: sfn.TaskInput.fromObject({ step: 'chunk', 'ref.$': '$.ref', 'chunkKey.$': '$.chunkKey' }), payloadResponseOnly: true }).addRetry({ maxAttempts: 3, interval: Duration.seconds(2) }));
    const summarise = invoke('Summarise', { step: 'summarise', 'ref.$': '$.ref', 'results.$': '$.results' }, sfn.JsonPath.DISCARD);
    const done = new sfn.Succeed(this, 'ImportDone');
    const body = validate.next(new sfn.Choice(this, 'Valid?').when(sfn.Condition.booleanEquals('$.validation.ok', true), chunkMap.next(summarise).next(done)).otherwise(done));
    const parallel = new sfn.Parallel(this, 'Import', { resultPath: sfn.JsonPath.DISCARD }).branch(body).addCatch(failTask, { resultPath: '$.error' });
    const importSm = new sfn.StateMachine(this, 'ImportStateMachine', {
      stateMachineName: `percy-${cfg.instance}-import`,
      definitionBody: sfn.DefinitionBody.fromChainable(new sfn.Pass(this, 'Wrap', { parameters: { 'ref.$': '$' } }).next(parallel)),
      tracingEnabled: true,
      logs: { destination: new logs.LogGroup(this, 'ImportSmLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: removal(cfg) }), level: sfn.LogLevel.ALL },
    });
    tagOwner(importSm, 'contactsg', 'async');
    importSm.grantStartExecution(scanResult);
    scanResult.addEnvironment('IMPORT_STATE_MACHINE_ARN', importSm.stateMachineArn);

    // Default-bus rules: S3 Object Created on raw/ and the GuardDuty scan result.
    new events.Rule(this, 'UploadCreatedRule', {
      eventPattern: { source: ['aws.s3'], detailType: ['Object Created'], detail: { bucket: { name: [uploads.bucketName] }, object: { key: [{ prefix: 'raw/' }] } } },
      targets: [new targets.LambdaFunction(scanResult, { retryAttempts: 4 })],
    });
    new events.Rule(this, 'ScanResultRule', {
      eventPattern: { source: ['aws.guardduty'], detailType: ['GuardDuty Malware Protection Object Scan Result'], detail: { s3ObjectDetails: { bucketName: [uploads.bucketName] } } },
      targets: [new targets.LambdaFunction(scanResult, { retryAttempts: 4 })],
    });

    // percy-domain bus rules.
    busRule(this, 'SuppressionRequestedRule', f.bus, { source: ['percy.engine'], detailType: ['SuppressionRequested'] }, suppressEvents.queue);
    if (cfg.instance === 'dev') {
      const testEvents = percyQueue(this, 'TestEvents', key, { queueName: `percy-${cfg.instance}-contactsg-test-events` });
      busRule(this, 'TestEventsRule', f.bus, { source: ['percy.contactsg'], detailType: ['ImportCompleted', 'SuppressionAdded', 'AudienceFrozen'] }, testEvents.queue);
    }

    suppress(this, [
      { id: 'AwsSolutions-IAM5', reason: 'CDK grants scope index/object wildcards to owned resources; SES ListEmailIdentities requires an account-wide wildcard resource for dev verification reads.' },
      { id: 'AwsSolutions-IAM4', reason: 'Lambda roles use AWSLambdaBasicExecutionRole for log delivery; CDK-provided custom resources do the same.', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'] },
      { id: 'AwsSolutions-L1', reason: LAMBDA_RUNTIME_REASON },
      { id: 'AwsSolutions-SQS3', reason: 'Dead-letter queues are the end of the redrive chain and are watched by DLQ-depth alarms.' },
    ]);
  }
}

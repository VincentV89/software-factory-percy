import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource, SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { InstanceConfig } from '../config';
import { LAMBDA_RUNTIME_REASON, PercyFunction, busRule, logBucket, outboxPipe, percyQueue, percyTable, removal, tagOwner } from '../constructs';
import { suppress } from '../nag';
import type { ContactSgStack } from './contactsg-stack';
import { names, type FoundationStack } from './foundation-stack';

const TIERS = ['standard', 'bulk'] as const;

/** Campaign Engine, split into control plane (cp) and data plane (dp) by function, queue and table (D-02). */
export class EngineStack extends Stack {
  readonly engineApi: PercyFunction;
  readonly unsubscribe: PercyFunction;
  readonly workers: Record<(typeof TIERS)[number], PercyFunction>;
  readonly cpFunctions: lambda.IFunction[];
  readonly dpFunctions: lambda.IFunction[];
  readonly campaignsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, cfg: InstanceConfig, f: FoundationStack, c: ContactSgStack, props: StackProps) {
    super(scope, id, props);
    const n = names(cfg);
    const key = f.keys.engine;
    const q = (name: string) => `percy-${cfg.instance}-${name}`;

    // ---- Tables: one writer plane each ----
    this.campaignsTable = percyTable(this, 'Campaigns', cfg, key, { tableName: n.table('engine-campaigns'), gsis: ['gsi1'] });
    const sendlog = percyTable(this, 'Sendlog', cfg, key, { tableName: n.table('engine-sendlog'), gsis: ['gsi1', 'gsi2'], stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES });
    const sendgate = percyTable(this, 'Sendgate', cfg, key, { tableName: n.table('engine-sendgate'), ttl: 'expiresAt' });
    const outbox = percyTable(this, 'Outbox', cfg, key, { tableName: n.table('engine-outbox'), ttl: 'expiresAt', stream: dynamodb.StreamViewType.NEW_IMAGE });
    outboxPipe(this, 'OutboxPipe', outbox, f.bus, key, 'engine');

    const accessLogs = logBucket(this, 'AccessLogs', cfg);
    const artifacts = new s3.Bucket(this, 'Artifacts', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      bucketKeyEnabled: true,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: 'artifacts/',
      lifecycleRules: [{ id: 'specs', expiration: Duration.days(30) }],
      removalPolicy: removal(cfg),
      autoDeleteObjects: !cfg.retain,
    });

    // ---- Queues ----
    const dlqs: sqs.Queue[] = [...c.dlqs];
    const commands = percyQueue(this, 'SendCommands', key, { queueName: q('send-commands.fifo'), fifo: true, visibilityTimeout: Duration.seconds(60) });
    const sesEvents = percyQueue(this, 'SesEvents', key, { queueName: q('ses-events'), visibilityTimeout: Duration.minutes(2) });
    const cpEvents = percyQueue(this, 'CpEvents', key, { queueName: q('engine-cp-events'), visibilityTimeout: Duration.minutes(2) });
    const sagaStart = percyQueue(this, 'SagaStart', key, { queueName: q('engine-saga-start'), visibilityTimeout: Duration.minutes(2) });
    const workerTimeout = Duration.minutes(15);
    const batches = Object.fromEntries(TIERS.map((t) => [t, percyQueue(this, `SendBatches-${t}`, key, { queueName: q(`send-batches-${t}`), visibilityTimeout: Duration.seconds(workerTimeout.toSeconds() * 6) })])) as Record<(typeof TIERS)[number], ReturnType<typeof percyQueue>>;
    dlqs.push(commands.dlq, sesEvents.dlq, cpEvents.dlq, sagaStart.dlq, ...TIERS.map((t) => batches[t].dlq));

    // ---- SES configuration set → SNS → ses-events (FR-FBK-01) ----
    const configSet = new ses.ConfigurationSet(this, 'ConfigSet', { configurationSetName: q('send'), reputationMetrics: true, sendingEnabled: true });
    const sesTopic = new sns.Topic(this, 'SesEventsTopic', { topicName: q('ses-events'), masterKey: key, enforceSSL: true });
    configSet.addEventDestination('ToSns', {
      destination: ses.EventDestination.snsTopic(sesTopic),
      events: [ses.EmailSendingEvent.DELIVERY, ses.EmailSendingEvent.BOUNCE, ses.EmailSendingEvent.COMPLAINT, ses.EmailSendingEvent.REJECT, ses.EmailSendingEvent.RENDERING_FAILURE],
    });
    sesTopic.addSubscription(new subs.SqsSubscription(sesEvents.queue, { rawMessageDelivery: true }));

    // ---- Shared environment ----
    const common: Record<string, string> = {
      CAMPAIGNS_TABLE: this.campaignsTable.tableName,
      SENDLOG_TABLE: sendlog.tableName,
      SENDGATE_TABLE: sendgate.tableName,
      ENGINE_OUTBOX_TABLE: outbox.tableName,
      ARTIFACTS_BUCKET: artifacts.bucketName,
      SNAPSHOTS_BUCKET: c.snapshotsBucket.bucketName,
      CONTACTS_TABLE: c.contactsTable.tableName,
      SUPPRESSIONS_TABLE: c.suppressionsTable.tableName,
      TENANCY_TABLE: f.tenancyTable.tableName,
      COMMANDS_QUEUE_URL: commands.queue.queueUrl,
      FREEZE_QUEUE_URL: c.freezeQueue.queueUrl,
      BATCH_QUEUE_STANDARD_URL: batches.standard.queue.queueUrl,
      BATCH_QUEUE_BULK_URL: batches.bulk.queue.queueUrl,
      UNSUBSCRIBE_SECRET_ID: f.unsubscribeSecret.secretArn,
      PUBLIC_BASE_URL_PARAM: n.publicBaseUrlParam,
      AUDIT_STREAM: f.auditStream.ref,
      FROM_ADDRESS: cfg.sesIdentity,
      CONFIGURATION_SET: configSet.configurationSetName,
      TIER_RATES: JSON.stringify(cfg.tierRates),
      STATUS_CACHE_MS: String(cfg.statusCacheMs),
      DEV_EXPORT: String(cfg.devExport),
      LIST_HOLD_FUNCTION: c.internalFn.functionName,
    };
    if (cfg.addressAllowList) common['ADDRESS_ALLOW_LIST'] = cfg.addressAllowList.join(',');
    const pick = (keys: string[]): Record<string, string> => Object.fromEntries(Object.entries(common).filter(([k]) => keys.includes(k)));
    const cpEnv = pick(['CAMPAIGNS_TABLE', 'SENDLOG_TABLE', 'ARTIFACTS_BUCKET', 'CONTACTS_TABLE', 'TENANCY_TABLE', 'COMMANDS_QUEUE_URL', 'FREEZE_QUEUE_URL', 'AUDIT_STREAM', 'FROM_ADDRESS', 'CONFIGURATION_SET', 'DEV_EXPORT', 'LIST_HOLD_FUNCTION', 'ADDRESS_ALLOW_LIST']);
    const dpEnv = Object.fromEntries(Object.entries(common).filter(([k]) => !['CAMPAIGNS_TABLE', 'COMMANDS_QUEUE_URL', 'FREEZE_QUEUE_URL', 'AUDIT_STREAM', 'TENANCY_TABLE', 'CONTACTS_TABLE', 'LIST_HOLD_FUNCTION', 'FROM_ADDRESS', 'CONFIGURATION_SET', 'ADDRESS_ALLOW_LIST'].includes(k)));

    const cpFn = (id: string, entry: string, description: string, timeout = Duration.seconds(30)): PercyFunction =>
      new PercyFunction(this, id, { entry: `packages/engine/src/cp/handlers/${entry}.ts`, context: 'engine', plane: 'cp', cfg, environment: cpEnv, description, timeout, memorySize: 1024 });
    const dpFn = (id: string, entry: string, description: string, opts: { timeout?: Duration; memorySize?: number; reservedConcurrentExecutions?: number; functionName?: string } = {}): PercyFunction =>
      new PercyFunction(this, id, { entry: `packages/engine/src/dp/handlers/${entry}.ts`, context: 'engine', plane: 'dp', cfg, environment: dpEnv, description, memorySize: 1024, ...opts });

    // ---- Control plane ----
    this.engineApi = cpFn('EngineApi', 'api', 'Engine cp API: templates, campaigns, kill switch, report');
    const fire = cpFn('ScheduleFire', 'schedule-fire', 'Scheduler target: SCHEDULED → FREEZING', Duration.minutes(1));
    const cpEventsFn = cpFn('CpEvents', 'cp-events', 'Applies bus events to campaign state', Duration.minutes(1));
    const schedGroup = new scheduler.CfnScheduleGroup(this, 'ScheduleGroup', { name: q('campaigns') });
    const schedRole = new iam.Role(this, 'SchedulerRole', { assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': this.account } } }) });
    tagOwner(schedRole, 'engine', 'cp');
    fire.grantInvoke(schedRole);
    for (const x of [this.engineApi, fire, cpEventsFn]) {
      this.campaignsTable.grantReadWriteData(x);
      sendlog.grantReadData(x);
      c.contactsTable.grantReadData(x);
      f.tenancyTable.grantReadData(x);
      commands.queue.grantSendMessages(x);
      c.freezeQueue.grantSendMessages(x);
      artifacts.grantReadWrite(x);
      c.internalFn.grantInvoke(x);
      f.grantAudit(x);
      x.addEnvironment('SCHEDULER_GROUP', schedGroup.ref);
      x.addEnvironment('SCHEDULER_ROLE_ARN', schedRole.roleArn);
      x.addToRolePolicy(new iam.PolicyStatement({ actions: ['scheduler:CreateSchedule', 'scheduler:DeleteSchedule', 'scheduler:GetSchedule'], resources: [this.formatArn({ service: 'scheduler', resource: 'schedule', resourceName: `${q('campaigns')}/*` })] }));
      x.addToRolePolicy(new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [schedRole.roleArn], conditions: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } } }));
    }
    this.engineApi.addEnvironment('SCHEDULE_FIRE_ARN', fire.functionArn);
    cpEventsFn.addEnvironment('SCHEDULE_FIRE_ARN', fire.functionArn);
    cpEventsFn.addEventSource(new SqsEventSource(cpEvents.queue, { batchSize: 10, reportBatchItemFailures: true }));

    // ---- Data plane ----
    const commandsFn = dpFn('Commands', 'commands', 'send-commands.fifo consumer', { timeout: Duration.seconds(30) });
    const sagaStartFn = dpFn('SagaStart', 'saga-start', 'AudienceFrozen → start send saga');
    const sagaSteps = dpFn('SagaSteps', 'saga-steps', 'Send saga, redrive and cancel tasks', { timeout: Duration.minutes(15), memorySize: 2048 });
    this.workers = Object.fromEntries(
      TIERS.map((t) => [t, dpFn(`SendWorker-${t}`, 'worker', `send-worker-${t}`, { timeout: workerTimeout, reservedConcurrentExecutions: cfg.workerReservedConcurrency, functionName: q(`send-worker-${t}`) })]),
    ) as Record<(typeof TIERS)[number], PercyFunction>;
    const feedback = dpFn('Feedback', 'feedback', 'SES events → send log + suppression requests', { timeout: Duration.minutes(1) });
    const aggregator = dpFn('Aggregator', 'aggregator', 'Send-log stream → counters and completion', { timeout: Duration.minutes(5) });
    const sweeper = dpFn('InDoubtSweeper', 'sweeper', 'Marks SENDING > 15 min as IN_DOUBT', { timeout: Duration.minutes(5) });
    this.unsubscribe = dpFn('Unsubscribe', 'unsubscribe', 'Citizen unsubscribe pages (percy-dp)');
    const quota = dpFn('SesQuotaProbe', 'quota-probe', 'Publishes SesQuotaUsedPct', { timeout: Duration.seconds(30) });
    const dpAll = [commandsFn, sagaStartFn, sagaSteps, ...TIERS.map((t) => this.workers[t]), feedback, aggregator, sweeper, this.unsubscribe, quota];

    const smLogs = (sid: string) => ({ destination: new logs.LogGroup(this, `${sid}Logs`, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: removal(cfg) }), level: sfn.LogLevel.ALL });
    const step = (sid: string, payload: Record<string, unknown>, resultPath?: string) =>
      new tasks.LambdaInvoke(this, sid, { lambdaFunction: sagaSteps, payload: sfn.TaskInput.fromObject(payload), payloadResponseOnly: true, resultPath, retryOnServiceExceptions: true });
    const partMap = new sfn.Map(this, 'Parts', { itemsPath: '$.init.parts', maxConcurrency: 10, itemSelector: { 'campaignId.$': '$.init.campaignId', 'mode.$': '$.init.mode', 'part.$': '$$.Map.Item.Value' }, resultPath: sfn.JsonPath.DISCARD });
    partMap.itemProcessor(step('CreateAndEnqueue', { step: 'part', 'campaignId.$': '$.campaignId', 'mode.$': '$.mode', 'part.$': '$.part' }).addRetry({ maxAttempts: 3, interval: Duration.seconds(2) }));
    const sagaDef = step('InitStatus', { step: 'init', 'frozen.$': '$' }, '$.init')
      .addRetry({ maxAttempts: 3, interval: Duration.seconds(2) })
      .next(new sfn.Choice(this, 'Mode').when(sfn.Condition.stringEquals('$.init.mode', 'done'), new sfn.Succeed(this, 'AlreadyDone')).otherwise(partMap.next(step('MarkCreated', { step: 'mark', 'campaignId.$': '$.init.campaignId' }, sfn.JsonPath.DISCARD))));
    const saga = new sfn.StateMachine(this, 'SendSaga', { stateMachineName: q('send-saga'), definitionBody: sfn.DefinitionBody.fromChainable(sagaDef), tracingEnabled: true, logs: smLogs('SendSaga') });
    const redrive = new sfn.StateMachine(this, 'Redrive', { stateMachineName: q('redrive'), definitionBody: sfn.DefinitionBody.fromChainable(step('RedriveTask', { step: 'redrive', 'campaignId.$': '$.campaignId' })), tracingEnabled: true, logs: smLogs('Redrive') });
    const cancel = new sfn.StateMachine(this, 'Cancel', { stateMachineName: q('cancel'), definitionBody: sfn.DefinitionBody.fromChainable(step('CancelTask', { step: 'cancel', 'campaignId.$': '$.campaignId' })), tracingEnabled: true, logs: smLogs('Cancel') });
    for (const sm of [saga, redrive, cancel]) tagOwner(sm, 'engine', 'dp');

    for (const x of dpAll) {
      sendlog.grantReadWriteData(x);
      sendgate.grantReadWriteData(x);
      outbox.grantWriteData(x);
      artifacts.grantRead(x);
      c.snapshotsBucket.grantRead(x);
      c.suppressionsTable.grantReadData(x);
      // Explicit principal-policy grants: a Secret.grantRead would edit the foundation key policy (stack cycle).
      x.addToRolePolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'], resources: [f.unsubscribeSecret.secretArn] }));
      x.addToRolePolicy(new iam.PolicyStatement({ actions: ['kms:Decrypt'], resources: [key.keyArn] }));
      x.addToRolePolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: n.publicBaseUrlParam.slice(1) })] }));
      for (const t of TIERS) batches[t].queue.grantSendMessages(x);
    }
    // Only the starters get state machine ARNs; giving them to saga-steps would form a cycle.
    sagaStartFn.addEnvironment('SAGA_STATE_MACHINE_ARN', saga.stateMachineArn);
    commandsFn.addEnvironment('REDRIVE_STATE_MACHINE_ARN', redrive.stateMachineArn);
    commandsFn.addEnvironment('CANCEL_STATE_MACHINE_ARN', cancel.stateMachineArn);
    saga.grantStartExecution(sagaStartFn);
    redrive.grantStartExecution(commandsFn);
    cancel.grantStartExecution(commandsFn);
    for (const t of TIERS) {
      const w = this.workers[t];
      w.addToRolePolicy(new iam.PolicyStatement({ actions: ['ses:SendEmail', 'ses:SendRawEmail'], resources: ['*'], conditions: { StringEquals: { 'ses:FromAddress': cfg.sesIdentity } } }));
      w.addToRolePolicy(new iam.PolicyStatement({ actions: ['cloudwatch:PutMetricData'], resources: ['*'], conditions: { StringEquals: { 'cloudwatch:namespace': 'Percy' } } }));
      w.addEventSource(new SqsEventSource(batches[t].queue, { batchSize: 1, reportBatchItemFailures: true, maxConcurrency: Math.max(2, cfg.workerReservedConcurrency) }));
    }
    quota.addToRolePolicy(new iam.PolicyStatement({ actions: ['ses:GetAccount'], resources: ['*'] }));
    quota.addToRolePolicy(new iam.PolicyStatement({ actions: ['cloudwatch:PutMetricData'], resources: ['*'], conditions: { StringEquals: { 'cloudwatch:namespace': 'Percy' } } }));
    commandsFn.addEventSource(new SqsEventSource(commands.queue, { batchSize: 1, reportBatchItemFailures: true }));
    sagaStartFn.addEventSource(new SqsEventSource(sagaStart.queue, { batchSize: 10, reportBatchItemFailures: true }));
    feedback.addEventSource(new SqsEventSource(sesEvents.queue, { batchSize: 10, reportBatchItemFailures: true }));
    aggregator.addEventSource(new DynamoEventSource(sendlog, { startingPosition: lambda.StartingPosition.TRIM_HORIZON, batchSize: 40, bisectBatchOnError: true, retryAttempts: 10, parallelizationFactor: 1 }));
    new events.Rule(this, 'SweeperSchedule', { schedule: events.Schedule.rate(Duration.minutes(5)), targets: [new targets.LambdaFunction(sweeper)] });
    new events.Rule(this, 'QuotaSchedule', { schedule: events.Schedule.rate(Duration.minutes(5)), targets: [new targets.LambdaFunction(quota)] });

    // ---- Bus rules ----
    busRule(this, 'PlatformToCp', f.bus, { source: ['percy.platform'], detailType: ['TeamSuspended', 'TeamReinstated', 'AgencySuspended', 'AgencyReinstated'] }, cpEvents.queue);
    busRule(this, 'FreezeFailedToCp', f.bus, { source: ['percy.contactsg'], detailType: ['AudienceFreezeFailed'] }, cpEvents.queue);
    busRule(this, 'ProgressToCp', f.bus, { source: ['percy.engine'], detailType: ['SendStarted', 'SendPaused', 'SendResumed', 'SendStopped', 'SendCompleted'] }, cpEvents.queue);
    busRule(this, 'FrozenToSaga', f.bus, { source: ['percy.contactsg'], detailType: ['AudienceFrozen'] }, sagaStart.queue);

    // ---- Alarms (NFR-OPS-01) ----
    const alarm = (aid: string, metric: cloudwatch.IMetric, threshold: number, op = cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD) => {
      const a = new cloudwatch.Alarm(this, aid, { metric, threshold, evaluationPeriods: 1, comparisonOperator: op, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING });
      a.addAlarmAction(new cwActions.SnsAction(f.alarmTopic));
      return a;
    };
    for (const d of dlqs) alarm(`${d.node.path.replace(/[^A-Za-z0-9]/g, '')}Depth`, d.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) }), 0);
    for (const t of TIERS) alarm(`WorkerErrors${t}`, this.workers[t].metricErrors({ period: Duration.minutes(1) }), 0);
    alarm('SesBounceRate', new cloudwatch.Metric({ namespace: 'AWS/SES', metricName: 'Reputation.BounceRate', period: Duration.minutes(15), statistic: 'Maximum' }), 0.05);
    alarm('SesComplaintRate', new cloudwatch.Metric({ namespace: 'AWS/SES', metricName: 'Reputation.ComplaintRate', period: Duration.minutes(15), statistic: 'Maximum' }), 0.001);
    alarm('SesQuota80', new cloudwatch.Metric({ namespace: 'Percy', metricName: 'SesQuotaUsedPct', dimensionsMap: { instance: cfg.instance }, period: Duration.minutes(5), statistic: 'Maximum' }), 80, cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD);
    alarm('CircuitBreaker', new cloudwatch.Metric({ namespace: 'Percy', metricName: 'CircuitBreakerPaused', dimensionsMap: { instance: cfg.instance }, period: Duration.minutes(1), statistic: 'Sum' }), 0);

    this.cpFunctions = [this.engineApi, fire, cpEventsFn];
    this.dpFunctions = dpAll;

    suppress(this, [
      { id: 'AwsSolutions-IAM5', reason: 'CDK grant helpers add index/* and object/* wildcards on Engine-owned resources; SES SendEmail is limited by ses:FromAddress and PutMetricData by namespace.' },
      { id: 'AwsSolutions-IAM4', reason: 'Lambda roles use AWSLambdaBasicExecutionRole for log delivery; CDK-provided custom resources do the same.', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'] },
      { id: 'AwsSolutions-L1', reason: LAMBDA_RUNTIME_REASON },
      { id: 'AwsSolutions-SQS3', reason: 'Dead-letter queues are the end of the redrive chain and are watched by DLQ-depth alarms.' },
    ]);
  }
}

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration, RemovalPolicy, Stack, Tags } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as pipes from 'aws-cdk-lib/aws-pipes';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { InstanceConfig } from './config';
import { suppress } from './nag';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const RUNTIME = lambda.Runtime.NODEJS_24_X;
export const LAMBDA_RUNTIME_REASON =
  'Percy functions are pinned to nodejs24.x, the LTS line the code is built and tested on; CDK-managed custom resources pin their own runtime. Move to nodejs26.x after a test pass.';

export type ContextName = 'platform' | 'contactsg' | 'engine';
export type Plane = 'cp' | 'dp' | 'async';

export const removal = (cfg: InstanceConfig): RemovalPolicy => (cfg.retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY);

/** Tags every role with its owning context and plane; the template architecture tests read them. */
export function tagOwner(c: Construct, context: ContextName, plane: Plane): void {
  Tags.of(c).add('percy:context', context);
  Tags.of(c).add('percy:plane', plane);
}

export interface PercyFunctionProps {
  entry: string;
  context: ContextName;
  plane: Plane;
  cfg: InstanceConfig;
  environment?: Record<string, string>;
  timeout?: Duration;
  memorySize?: number;
  reservedConcurrentExecutions?: number;
  description?: string;
  functionName?: string;
}

/** NodejsFunction bundled by the local esbuild (no Docker), X-Ray on, JSON logs, tagged owner. */
export class PercyFunction extends NodejsFunction {
  constructor(scope: Construct, id: string, props: PercyFunctionProps) {
    const logGroup = new logs.LogGroup(scope, `${id}Logs`, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: removal(props.cfg) });
    super(scope, id, {
      entry: path.join(REPO_ROOT, props.entry),
      handler: 'handler',
      runtime: RUNTIME,
      architecture: lambda.Architecture.ARM_64,
      memorySize: props.memorySize ?? 512,
      timeout: props.timeout ?? Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      loggingFormat: lambda.LoggingFormat.JSON,
      logGroup,
      reservedConcurrentExecutions: props.reservedConcurrentExecutions,
      description: props.description,
      functionName: props.functionName,
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
      environment: { PERCY_INSTANCE: props.cfg.instance, NODE_OPTIONS: '--enable-source-maps', ...props.environment },
      bundling: { minify: true, sourceMap: true, target: 'node24', format: OutputFormat.CJS, externalModules: [], mainFields: ['module', 'main'] },
    });
    tagOwner(this, props.context, props.plane);
  }
}

export function percyTable(scope: Construct, id: string, cfg: InstanceConfig, key: kms.IKey, opts: { gsis?: string[]; ttl?: string; stream?: dynamodb.StreamViewType; tableName: string }): dynamodb.Table {
  const table = new dynamodb.Table(scope, id, {
    tableName: opts.tableName,
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
    encryptionKey: key,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    timeToLiveAttribute: opts.ttl,
    stream: opts.stream,
    removalPolicy: removal(cfg),
    deletionProtection: cfg.retain,
  });
  for (const g of opts.gsis ?? []) {
    table.addGlobalSecondaryIndex({
      indexName: g,
      partitionKey: { name: `${g}pk`, type: dynamodb.AttributeType.STRING },
      sortKey: { name: `${g}sk`, type: g === 'gsi2' && opts.tableName.endsWith('sendlog') ? dynamodb.AttributeType.NUMBER : dynamodb.AttributeType.STRING },
    });
  }
  return table;
}

export interface QueueWithDlq {
  queue: sqs.Queue;
  dlq: sqs.Queue;
}

export function percyQueue(scope: Construct, id: string, key: kms.IKey, opts: { queueName: string; fifo?: boolean; visibilityTimeout?: Duration; maxReceiveCount?: number }): QueueWithDlq {
  const suffix = opts.fifo ? '.fifo' : '';
  const base = opts.queueName.replace(/\.fifo$/, '');
  const dlq = new sqs.Queue(scope, `${id}Dlq`, {
    queueName: `${base}-dlq${suffix}`,
    fifo: opts.fifo,
    encryption: sqs.QueueEncryption.KMS,
    encryptionMasterKey: key,
    enforceSSL: true,
    retentionPeriod: Duration.days(14),
  });
  const queue = new sqs.Queue(scope, `${id}Queue`, {
    queueName: `${base}${suffix}`,
    fifo: opts.fifo,
    contentBasedDeduplication: false,
    encryption: sqs.QueueEncryption.KMS,
    encryptionMasterKey: key,
    enforceSSL: true,
    visibilityTimeout: opts.visibilityTimeout ?? Duration.seconds(60),
    deadLetterQueue: { queue: dlq, maxReceiveCount: opts.maxReceiveCount ?? 3 },
  });
  return { queue, dlq };
}

export function logBucket(scope: Construct, id: string, cfg: InstanceConfig, opts: { objectWriter?: boolean } = {}): s3.Bucket {
  const bucket = new s3.Bucket(scope, id, {
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    objectOwnership: opts.objectWriter ? s3.ObjectOwnership.OBJECT_WRITER : s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    lifecycleRules: [{ expiration: Duration.days(90) }],
    removalPolicy: removal(cfg),
    autoDeleteObjects: !cfg.retain,
  });
  suppress(bucket, [{ id: 'AwsSolutions-S1', reason: 'This is the access-log destination bucket; logging it into itself would loop.' }]);
  return bucket;
}

/** Transactional outbox publisher: DynamoDB stream INSERTs → EventBridge Pipes → percy-domain bus (ADR-10). */
export function outboxPipe(scope: Construct, id: string, table: dynamodb.Table, bus: events.IEventBus, key: kms.IKey, context: ContextName): pipes.CfnPipe {
  const role = new iam.Role(scope, `${id}Role`, { assumedBy: new iam.ServicePrincipal('pipes.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': Stack.of(scope).account } } }) });
  tagOwner(role, context, 'async');
  table.grantStreamRead(role);
  key.grantDecrypt(role);
  bus.grantPutEventsTo(role);
  const pipe = new pipes.CfnPipe(scope, id, {
    roleArn: role.roleArn,
    source: table.tableStreamArn ?? '',
    sourceParameters: {
      dynamoDbStreamParameters: { startingPosition: 'TRIM_HORIZON', batchSize: 10, maximumRetryAttempts: 185, maximumRecordAgeInSeconds: 86400 },
      filterCriteria: { filters: [{ pattern: JSON.stringify({ eventName: ['INSERT'] }) }] },
    },
    target: bus.eventBusArn,
    targetParameters: {
      eventBridgeEventBusParameters: { detailType: '$.dynamodb.NewImage.event.M.type.S', source: '$.dynamodb.NewImage.event.M.source.S' },
    },
  });
  suppress(role, [{ id: 'AwsSolutions-IAM5', reason: 'grantStreamRead requires the stream ARN wildcard (table/<name>/stream/*) generated by CDK.' }]);
  return pipe;
}

/** Bus rule → SQS consumer queue with DLQ. */
export function busRule(scope: Construct, id: string, bus: events.IEventBus, pattern: events.EventPattern, queue: sqs.IQueue): events.Rule {
  return new events.Rule(scope, id, { eventBus: bus, eventPattern: pattern, targets: [new targets.SqsQueue(queue)] });
}

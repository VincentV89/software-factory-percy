import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { MetricsSink, ObjectStore, OutgoingMessage, ParamStore, PresignedUpload, QueueSender, SecretStore, UploadSigner, WorkflowStarter } from '../ports';

export class SqsQueueSender implements QueueSender {
  constructor(private readonly sqs = new SQSClient({})) {}
  async send(queueUrl: string, m: OutgoingMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(m.body),
        MessageGroupId: m.groupId,
        MessageDeduplicationId: m.dedupeId,
        DelaySeconds: m.groupId ? undefined : m.delaySeconds,
      }),
    );
  }
}

export class S3ObjectStore implements ObjectStore, UploadSigner {
  constructor(private readonly s3 = new S3Client({}), private readonly kmsKeyFor: (bucket: string) => string | undefined = () => undefined) {}

  async put(bucket: string, key: string, body: string | Uint8Array, opts?: { contentType?: string }): Promise<void> {
    const kms = this.kmsKeyFor(bucket);
    await this.s3.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: opts?.contentType, ServerSideEncryption: kms ? 'aws:kms' : undefined, SSEKMSKeyId: kms }),
    );
  }

  async get(bucket: string, key: string): Promise<Uint8Array | undefined> {
    try {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return out.Body ? await out.Body.transformToByteArray() : undefined;
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return undefined;
      throw e;
    }
  }

  async delete(bucket: string, key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  async list(bucket: string, prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const out = await this.s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
      keys.push(...(out.Contents ?? []).map((o) => o.Key ?? '').filter(Boolean));
      token = out.NextContinuationToken;
    } while (token);
    return keys.sort();
  }

  async presignPost(bucket: string, key: string, maxBytes: number, expiresSeconds: number): Promise<PresignedUpload> {
    const kms = this.kmsKeyFor(bucket);
    const fields: Record<string, string> = kms ? { 'x-amz-server-side-encryption': 'aws:kms', 'x-amz-server-side-encryption-aws-kms-key-id': kms } : {};
    const post = await createPresignedPost(this.s3, {
      Bucket: bucket,
      Key: key,
      Expires: expiresSeconds,
      Fields: fields,
      Conditions: [['content-length-range', 1, maxBytes], ...Object.entries(fields).map(([k, v]) => ({ [k]: v }))],
    });
    return { url: post.url, fields: post.fields };
  }
}

export class SfnWorkflowStarter implements WorkflowStarter {
  constructor(private readonly sfn = new SFNClient({})) {}
  async start(stateMachineArn: string, executionName: string, input: unknown): Promise<boolean> {
    try {
      await this.sfn.send(new StartExecutionCommand({ stateMachineArn, name: executionName.slice(0, 80), input: JSON.stringify(input) }));
      return true;
    } catch (e) {
      if ((e as { name?: string }).name === 'ExecutionAlreadyExists') return false;
      throw e;
    }
  }
}

export class AwsSecrets implements SecretStore, ParamStore {
  constructor(private readonly sm = new SecretsManagerClient({}), private readonly ssm = new SSMClient({})) {}
  async getSecret(id: string): Promise<string> {
    const out = await this.sm.send(new GetSecretValueCommand({ SecretId: id }));
    if (!out.SecretString) throw new Error(`secret ${id} has no string value`);
    return out.SecretString;
  }
  async getParam(name: string): Promise<string> {
    const out = await this.ssm.send(new GetParameterCommand({ Name: name }));
    const v = out.Parameter?.Value;
    if (!v) throw new Error(`parameter ${name} has no value`);
    return v;
  }
}

export class CloudWatchMetrics implements MetricsSink {
  constructor(private readonly namespace = 'Percy', private readonly cw = new CloudWatchClient({})) {}
  async put(name: string, value: number, dimensions: Record<string, string> = {}): Promise<void> {
    await this.cw.send(
      new PutMetricDataCommand({
        Namespace: this.namespace,
        MetricData: [{ MetricName: name, Value: value, Dimensions: Object.entries(dimensions).map(([Name, Value]) => ({ Name, Value })) }],
      }),
    );
  }
}

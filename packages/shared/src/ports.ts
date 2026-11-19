/** Infrastructure ports shared by every context. Adapters: `memory/` for local, `aws/` for Lambda. */

export interface OutgoingMessage {
  body: unknown;
  /** FIFO message group id. */
  groupId?: string;
  /** FIFO deduplication id. */
  dedupeId?: string;
  delaySeconds?: number;
}

export interface QueueSender {
  send(queue: string, message: OutgoingMessage): Promise<void>;
}

export interface ObjectStore {
  put(bucket: string, key: string, body: string | Uint8Array, opts?: { contentType?: string }): Promise<void>;
  get(bucket: string, key: string): Promise<Uint8Array | undefined>;
  delete(bucket: string, key: string): Promise<void>;
  list(bucket: string, prefix: string): Promise<string[]>;
}

export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
}

export interface UploadSigner {
  presignPost(bucket: string, key: string, maxBytes: number, expiresSeconds: number): Promise<PresignedUpload>;
}

export interface WorkflowStarter {
  /** Starts an execution; returns false when an execution with that name already exists. */
  start(stateMachine: string, executionName: string, input: unknown): Promise<boolean>;
}

export interface SecretStore {
  getSecret(id: string): Promise<string>;
}

export interface ParamStore {
  getParam(name: string): Promise<string>;
}

export interface MetricsSink {
  put(name: string, value: number, dimensions?: Record<string, string>): Promise<void>;
}

/** Caches a value for `ttlMs`, used for secrets and parameters fetched at runtime by name. */
export function cached<T>(load: () => Promise<T>, ttlMs: number, now: () => number = Date.now): () => Promise<T> {
  let value: T | undefined;
  let loadedAt = 0;
  return async () => {
    if (value === undefined || now() - loadedAt > ttlMs) {
      value = await load();
      loadedAt = now();
    }
    return value;
  };
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
}

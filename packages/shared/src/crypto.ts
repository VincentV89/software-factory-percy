import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

export function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export function fromBase64url(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

/** Constant-time comparison of two strings; false when lengths differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Random token with `bytes` of entropy, base64url encoded. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Time-sortable id: 10 chars of base36 milliseconds plus 12 random hex chars. */
export function newId(now: number = Date.now()): string {
  return now.toString(36).padStart(10, '0') + randomBytes(6).toString('hex');
}

export function uuid(): string {
  return randomUUID();
}

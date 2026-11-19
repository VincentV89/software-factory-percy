import { sha256Hex } from './crypto';
import { err, ok, type Result } from './result';

/** Branded normalised email (trimmed, whole address lower-cased, syntax checked). */
export type NormalisedEmail = string & { readonly __brand: 'NormalisedEmail' };
/** SHA-256 hex of a normalised email. */
export type AddressHash = string & { readonly __brand: 'AddressHash' };

// Pragmatic syntax check: one @, non-empty local part, dotted domain, no spaces.
const EMAIL_PATTERN = /^[^\s@"(),:;<>[\]\\]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const MAX_EMAIL_LENGTH = 254;

export function normaliseEmail(raw: string): Result<NormalisedEmail, string> {
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return err('email is empty');
  if (value.length > MAX_EMAIL_LENGTH) return err('email is longer than 254 characters');
  if (!EMAIL_PATTERN.test(value)) return err('email syntax is invalid');
  return ok(value as NormalisedEmail);
}

export function addressHash(email: NormalisedEmail): AddressHash {
  return sha256Hex(email) as AddressHash;
}

/** Normalise then hash; throws on invalid syntax. Use only on already-validated input. */
export function hashOf(raw: string): AddressHash {
  const n = normaliseEmail(raw);
  if (!n.ok) throw new Error(`cannot hash invalid email: ${n.error}`);
  return addressHash(n.value);
}

export const EMAIL_LIKE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

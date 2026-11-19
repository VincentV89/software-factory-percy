/**
 * Typed domain errors. Handlers throw these; the HTTP layer maps them to status codes
 * and the `{ error: { code, message, details } }` envelope.
 */
export interface ErrorDetail {
  field?: string;
  reason: string;
  [key: string]: unknown;
}

export abstract class DomainError extends Error {
  abstract readonly status: number;
  abstract readonly code: string;
  readonly details: ErrorDetail[];

  constructor(message: string, details: ErrorDetail[] = []) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

export class ValidationError extends DomainError {
  readonly status = 400;
  readonly code = 'VALIDATION_FAILED';
}

export class Unauthenticated extends DomainError {
  readonly status = 401;
  readonly code = 'UNAUTHENTICATED';
  constructor(message = 'Sign-in required.') {
    super(message);
  }
}

export class Forbidden extends DomainError {
  readonly status = 403;
  readonly code = 'FORBIDDEN';
  constructor(message = 'You do not have permission to do this.') {
    super(message);
  }
}

export class NotFound extends DomainError {
  readonly status = 404;
  readonly code = 'NOT_FOUND';
  constructor(message = 'Not found.') {
    super(message);
  }
}

export class Conflict extends DomainError {
  readonly status: number = 409;
  readonly code: string = 'CONFLICT';
}

export class InvalidTransition extends Conflict {
  override readonly code = 'INVALID_TRANSITION';
}

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}

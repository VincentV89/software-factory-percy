import { describe, expect, it } from 'vitest';
import { classifySesError } from '../src';

describe('SES error classification (ADR-05)', () => {
  it('only definite non-acceptance reverts; timeouts are unknown', () => {
    expect(classifySesError({ name: 'TooManyRequestsException' })).toEqual({ kind: 'throttled', code: 'TooManyRequestsException' });
    expect(classifySesError({ name: 'MessageRejected' })).toEqual({ kind: 'rejected', code: 'MessageRejected' });
    expect(classifySesError({ name: 'TimeoutError' })).toEqual({ kind: 'unknown', code: 'TimeoutError' });
    expect(classifySesError({})).toEqual({ kind: 'unknown', code: 'Unknown' });
  });
});

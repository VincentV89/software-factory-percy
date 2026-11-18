import type { APIGatewayAuthorizerResult, APIGatewayRequestAuthorizerEvent } from 'aws-lambda';
import { DomainError } from '@percy/shared';
import { authorize } from '../index';
import { platformRuntime } from './runtime';

const rt = platformRuntime('platform-authorizer');

function policy(effect: 'Allow' | 'Deny', resource: string, context?: Record<string, string>): APIGatewayAuthorizerResult {
  return {
    principalId: context?.['officerId'] ?? 'anonymous',
    policyDocument: { Version: '2012-10-17', Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resource }] },
    context,
  };
}

/**
 * API Gateway REQUEST authorizer (ADR-02), result caching off. Throwing "Unauthorized" makes
 * API Gateway answer 401; a Deny policy answers 403.
 */
export async function handler(event: APIGatewayRequestAuthorizerEvent): Promise<APIGatewayAuthorizerResult> {
  const headers = event.headers ?? {};
  const get = (n: string): string | undefined => Object.entries(headers).find(([k]) => k.toLowerCase() === n)?.[1] ?? undefined;
  try {
    const principal = await authorize(
      { method: event.httpMethod, path: event.path, cookieHeader: get('cookie'), csrfHeader: get('x-csrf-token'), requestId: event.requestContext.requestId },
      rt,
    );
    return policy('Allow', event.methodArn, { officerId: principal.officerId, principal: JSON.stringify(principal) });
  } catch (e) {
    if (e instanceof DomainError && e.status === 401) throw new Error('Unauthorized');
    if (e instanceof DomainError && e.status === 403) return policy('Deny', event.methodArn);
    rt.logger.error('authorizer failed', { error: e as Error });
    throw new Error('Unauthorized');
  }
}

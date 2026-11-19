import { z } from 'zod';
import { DomainError, NotFound, ValidationError } from './errors';
import type { Logger } from './log';

/** Subset of the API Gateway REST (v1) proxy event that Percy handlers use. */
export interface ApiEvent {
  httpMethod: string;
  path: string;
  headers?: Record<string, string | undefined> | null;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { requestId?: string; authorizer?: Record<string, unknown> | null; identity?: { sourceIp?: string } };
}

export interface ApiResult {
  statusCode: number;
  headers?: Record<string, string>;
  multiValueHeaders?: Record<string, string[]>;
  body: string;
}

export interface RouteContext {
  event: ApiEvent;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  requestId: string;
  header(name: string): string | undefined;
  json(): unknown;
}

export type RouteHandler = (ctx: RouteContext) => Promise<ApiResult>;

export function header(event: ApiEvent, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(event.headers ?? {})) if (k.toLowerCase() === lower) return v ?? undefined;
  return undefined;
}

export function rawBody(event: ApiEvent): string {
  if (!event.body) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

export function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): ApiResult {
  return { statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }, body: JSON.stringify(body) };
}

export function errorResult(e: DomainError, requestId: string): ApiResult {
  return json(e.status, { error: { code: e.code, message: e.message, details: e.details, requestId } });
}

export function parseBody<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(
      'One or more fields failed validation.',
      result.error.issues.map((i) => ({ field: i.path.join('.') || undefined, reason: i.message })),
    );
  }
  return result.data as z.infer<T>;
}

interface Route {
  method: string;
  pattern: RegExp;
  names: string[];
  handler: RouteHandler;
}

/** Minimal path router for one `{proxy+}` Lambda per context. Patterns use `:name` segments. */
export class Router {
  private routes: Route[] = [];

  constructor(private readonly logger?: Logger) {}

  add(method: string, path: string, handler: RouteHandler): this {
    const names: string[] = [];
    const pattern = new RegExp(
      '^' +
        path
          .split('/')
          .map((seg) => {
            if (seg.startsWith(':')) {
              names.push(seg.slice(1));
              return '([^/]+)';
            }
            return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          })
          .join('/') +
        '/?$',
    );
    this.routes.push({ method, pattern, names, handler });
    return this;
  }

  get = (p: string, h: RouteHandler): this => this.add('GET', p, h);
  post = (p: string, h: RouteHandler): this => this.add('POST', p, h);
  put = (p: string, h: RouteHandler): this => this.add('PUT', p, h);
  patch = (p: string, h: RouteHandler): this => this.add('PATCH', p, h);
  del = (p: string, h: RouteHandler): this => this.add('DELETE', p, h);

  async handle(event: ApiEvent): Promise<ApiResult> {
    const requestId = event.requestContext?.requestId ?? 'local';
    try {
      for (const r of this.routes) {
        if (r.method !== event.httpMethod) continue;
        const m = r.pattern.exec(event.path);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1] ?? '')));
        let parsed: unknown;
        let parsedOnce = false;
        const ctx: RouteContext = {
          event,
          params,
          query: event.queryStringParameters ?? {},
          requestId,
          header: (name) => header(event, name),
          json: () => {
            if (!parsedOnce) {
              parsedOnce = true;
              const text = rawBody(event);
              try {
                parsed = text ? JSON.parse(text) : {};
              } catch {
                throw new ValidationError('Request body is not valid JSON.');
              }
            }
            return parsed;
          },
        };
        return await r.handler(ctx);
      }
      throw new NotFound('No such route.');
    } catch (e) {
      if (e instanceof DomainError) {
        if (e.status >= 500) this.logger?.error('request failed', { requestId, error: e });
        return errorResult(e, requestId);
      }
      this.logger?.error('unhandled error', { requestId, path: event.path, error: e instanceof Error ? e : String(e) });
      return json(500, { error: { code: 'INTERNAL', message: 'Something went wrong.', details: [], requestId } });
    }
  }
}

import { Router, header, type ApiEvent, type ApiResult } from '@percy/shared';
import { requireEnv } from '@percy/shared';
import { CognitoOidcClient, callback, login, logout, type BffDeps } from '../index';
import { platformRuntime } from './runtime';

const rt = platformRuntime('platform-bff');
const deps: BffDeps = {
  ...rt,
  oidc: new CognitoOidcClient(
    { domainUrl: requireEnv('COGNITO_DOMAIN_URL'), issuer: requireEnv('COGNITO_ISSUER'), clientSecretId: requireEnv('COGNITO_CLIENT_SECRET_ID') },
    rt.secrets,
  ),
};

const router = new Router(rt.logger)
  .get('/auth/login', () => login(deps))
  .get('/auth/callback', (ctx) => callback({ code: ctx.query['code'], state: ctx.query['state'], cookieHeader: ctx.header('cookie'), requestId: ctx.requestId }, deps))
  .post('/auth/logout', (ctx) => logout({ cookieHeader: ctx.header('cookie'), csrfHeader: header(ctx.event, 'x-csrf-token'), requestId: ctx.requestId }, deps));

export const handler = (event: ApiEvent): Promise<ApiResult> => router.handle(event);

import type { ApiEvent, ApiResult } from '@percy/shared';
import { createPlatformApi } from '../index';
import { platformRuntime } from './runtime';
import { requireEnv } from '@percy/shared';
import { CognitoOfficerInvitations } from '../officer-invitations';

const router = createPlatformApi({
  ...platformRuntime('platform-api'),
  testingEnabled: process.env['PERCY_INSTANCE'] === 'dev',
  invitations: new CognitoOfficerInvitations(requireEnv('COGNITO_USER_POOL_ID')),
});

export const handler = (event: ApiEvent): Promise<ApiResult> => router.handle(event);

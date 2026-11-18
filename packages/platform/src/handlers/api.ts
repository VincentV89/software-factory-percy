import type { ApiEvent, ApiResult } from '@percy/shared';
import { createPlatformApi } from '../index';
import { platformRuntime } from './runtime';

const router = createPlatformApi(platformRuntime('platform-api'));

export const handler = (event: ApiEvent): Promise<ApiResult> => router.handle(event);

import type { ApiEvent, ApiResult } from '@percy/shared';
import { createEngineApi } from '../api';
import { engineCpRuntime } from './runtime';

const router = createEngineApi(engineCpRuntime('engine-api'));

export const handler = (event: ApiEvent): Promise<ApiResult> => router.handle(event);

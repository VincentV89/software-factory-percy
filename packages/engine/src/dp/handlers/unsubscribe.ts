import type { ApiEvent, ApiResult } from '@percy/shared';
import { createUnsubscribeHandler } from '../unsubscribe';
import { engineDpRuntime } from './runtime';

const handle = createUnsubscribeHandler(engineDpRuntime('engine-unsubscribe'));

export const handler = (event: ApiEvent): Promise<ApiResult> => handle(event);

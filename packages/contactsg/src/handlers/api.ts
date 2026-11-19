import type { ApiEvent, ApiResult } from '@percy/shared';
import { createContactSgApi } from '../index';
import { contactSgRuntime } from './runtime';

const router = createContactSgApi(contactSgRuntime('contactsg-api'));

export const handler = (event: ApiEvent): Promise<ApiResult> => router.handle(event);

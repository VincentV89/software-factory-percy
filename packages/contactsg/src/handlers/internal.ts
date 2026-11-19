import { NotFound } from '@percy/shared';
import { listHoldRequestSchema } from '@percy/contactsg-contract';
import { ListService } from '../index';
import { contactSgRuntime } from './runtime';

const lists = new ListService(contactSgRuntime('contactsg-internal'));

/** contactsg-internal: list holds for the Engine control plane (invoked synchronously, cp→cp). */
export async function handler(input: unknown): Promise<{ ok: boolean; notFound?: boolean }> {
  const req = listHoldRequestSchema.parse(input);
  try {
    if (req.op === 'acquire') await lists.acquireHold(req.teamId, req.listId, req.holderRef);
    else await lists.releaseHold(req.teamId, req.listId, req.holderRef);
    return { ok: true };
  } catch (e) {
    if (e instanceof NotFound) return { ok: false, notFound: true };
    throw e;
  }
}

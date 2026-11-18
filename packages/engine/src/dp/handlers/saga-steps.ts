import type { AudienceFrozen } from '@percy/contactsg-contract';
import { SendSaga } from '../saga';
import { engineDpRuntime } from './runtime';

const saga = new SendSaga(engineDpRuntime('engine-saga'));

type Step =
  | { step: 'init'; frozen: AudienceFrozen }
  | { step: 'part'; campaignId: string; mode: 'send' | 'cancel'; part: { index: number; key: string } }
  | { step: 'mark'; campaignId: string }
  | { step: 'redrive'; campaignId: string }
  | { step: 'cancel'; campaignId: string };

/** Task Lambda for the send saga, redrive and cancel state machines. */
export async function handler(input: Step): Promise<unknown> {
  switch (input.step) {
    case 'init':
      return saga.initStatus(input.frozen);
    case 'part':
      return { created: await saga.createPart(input.campaignId, input.part, input.mode) };
    case 'mark':
      await saga.markCreated(input.campaignId);
      return { ok: true };
    case 'redrive':
      return { enqueued: await saga.redrive(input.campaignId) };
    case 'cancel':
      return { cancelled: await saga.cancel(input.campaignId) };
  }
}

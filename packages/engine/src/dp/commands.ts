import { cond, isConditionFailure } from '@percy/shared';
import type { SendCommand } from '@percy/engine-contract';
import { sendlogKeys } from '../domain/send';
import { activeGates, eventOp, getStatus, type EngineDpDeps } from './deps';

/**
 * engine-commands: applies send-commands.fifo messages to STATUS and the gates. Business
 * conditions never throw, so a FIFO message group can never be blocked by retries (R8).
 */
export function createCommandHandler(d: EngineDpDeps) {
  const ignore = (e: unknown): void => {
    if (!isConditionFailure(e)) throw e;
  };

  return async function handle(cmd: SendCommand): Promise<string> {
    const t = d.tables;
    switch (cmd.type) {
      case 'SET_GATE':
        await d.kv.put(t.sendgate, { pk: `GATE#${cmd.gateScope ?? 'GLOBAL'}`, sk: 'GATE', reason: cmd.reason ?? '', setAt: cmd.issuedAt });
        return 'gate-set';
      case 'CLEAR_GATE':
        await d.kv.delete(t.sendgate, { pk: `GATE#${cmd.gateScope ?? 'GLOBAL'}`, sk: 'GATE' });
        return 'gate-cleared';
      case 'RESEND':
        return 'unsupported';
    }
    const campaignId = cmd.campaignId;
    if (!campaignId) return 'invalid';
    const key = sendlogKeys.status(campaignId);
    const status = await getStatus(d, campaignId);
    const teamId = String(status?.['teamId'] ?? '');

    if (cmd.type === 'PAUSE') {
      if (status?.['status'] !== 'SENDING') return 'noop';
      const reason = cmd.reason ?? 'OFFICER';
      await d.kv.transact([{ kind: 'update', table: t.sendlog, key, update: { set: { status: 'PAUSED', reason } }, cond: cond.eq('status', 'SENDING') }, eventOp(d, 'SendPaused', { campaignId, teamId, reason })]).catch(ignore);
      return 'paused';
    }

    if (cmd.type === 'RESUME') {
      if (status?.['status'] !== 'PAUSED') return 'noop';
      const gates = await activeGates(d, String(status['agencyId']), teamId);
      if (gates.length > 0) {
        d.logger.warn('resume refused under gate', { campaignId, gates });
        return 'gated';
      }
      try {
        await d.kv.transact([
          { kind: 'update', table: t.sendlog, key, update: { set: { status: 'SENDING' }, remove: ['reason', 'throttledSince'] }, cond: cond.eq('status', 'PAUSED') },
          eventOp(d, 'SendResumed', { campaignId, teamId }),
        ]);
      } catch (e) {
        ignore(e);
        return 'noop';
      }
      await d.workflows.start(d.stateMachines.redrive, `redrive-${campaignId}-${cmd.commandId}`, { campaignId });
      return 'resumed';
    }

    // STOP
    if (!status) {
      // Stop during freeze: the saga's InitStatus sees STOPPED and cancels every recipient.
      await d.kv.put(t.sendlog, { ...key, campaignId, status: 'STOPPED', reason: 'OFFICER' }, cond.itemAbsent()).catch(ignore);
      return 'stopped-before-start';
    }
    if (status['status'] !== 'SENDING' && status['status'] !== 'PAUSED') return 'noop';
    try {
      await d.kv.transact([
        { kind: 'update', table: t.sendlog, key, update: { set: { status: 'STOPPED', reason: 'OFFICER' } }, cond: cond.in('status', ['SENDING', 'PAUSED']) },
        eventOp(d, 'SendStopped', { campaignId, teamId }),
      ]);
    } catch (e) {
      ignore(e);
      return 'noop';
    }
    await d.workflows.start(d.stateMachines.cancel, `cancel-${campaignId}`, { campaignId });
    return 'stopped';
  };
}

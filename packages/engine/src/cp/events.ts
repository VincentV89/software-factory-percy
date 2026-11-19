import type { EventEnvelope } from '@percy/shared';
import { audienceFreezeFailedSchema } from '@percy/contactsg-contract';
import { agencyReinstatedSchema, agencySuspendedSchema, teamReinstatedSchema, teamSuspendedSchema } from '@percy/platform-contract';
import { sendProgressSchema } from '@percy/engine-contract';
import { CampaignService, parseRequestRef } from './campaigns';
import type { EngineCpDeps } from './deps';

/**
 * engine-cp-events: applies Platform, ContactSG and data-plane events to the officer-visible
 * campaign state. This is the only way data-plane progress reaches the control plane.
 */
export function createCpEventHandler(d: EngineCpDeps) {
  const campaigns = new CampaignService(d);

  const release = async (teamId: string, listId: string, campaignId: string): Promise<void> => {
    await d.holds.release(teamId, listId, campaignId).catch((e: unknown) => d.logger.warn('hold release failed', { campaignId, error: e as Error }));
  };

  return async function handle(e: EventEnvelope): Promise<void> {
    switch (e.type) {
      case 'TeamSuspended': {
        const p = teamSuspendedSchema.parse(e.payload);
        await campaigns.applyKill(`TEAM#${p.teamId}`, `suspended: ${p.reason}`, p.by, p.agencyId);
        return;
      }
      case 'AgencySuspended': {
        const p = agencySuspendedSchema.parse(e.payload);
        await campaigns.applyKill(`AGENCY#${p.agencyId}`, `suspended: ${p.reason}`, p.by, p.agencyId);
        return;
      }
      case 'TeamReinstated': {
        const p = teamReinstatedSchema.parse(e.payload);
        await campaigns.removeKill(`TEAM#${p.teamId}`, p.by);
        return;
      }
      case 'AgencyReinstated': {
        const p = agencyReinstatedSchema.parse(e.payload);
        await campaigns.removeKill(`AGENCY#${p.agencyId}`, p.by);
        return;
      }
      case 'AudienceFreezeFailed': {
        const p = audienceFreezeFailedSchema.parse(e.payload);
        const { teamId, campaignId } = parseRequestRef(p.requestRef);
        const c = await campaigns.syncState(teamId, campaignId, (c) => (c.state === 'FREEZING' && c.freezeId === p.freezeId ? { state: 'APPROVED', error: p.reason, scheduleAt: undefined } : undefined));
        if (c && c.state === 'APPROVED') await release(teamId, c.listId, campaignId);
        return;
      }
      case 'SendStarted':
      case 'SendPaused':
      case 'SendResumed':
      case 'SendStopped':
      case 'SendCompleted': {
        const p = sendProgressSchema.parse(e.payload);
        const c = await campaigns.syncState(p.teamId, p.campaignId, (c) => {
          const frozenAt = c.frozenAt ?? e.occurredAt;
          switch (e.type) {
            case 'SendStarted':
              return c.state === 'FREEZING' ? { state: 'SENDING', frozenAt } : undefined;
            case 'SendPaused':
              return c.state === 'FREEZING' || c.state === 'SENDING' ? { state: 'PAUSED', pausedReason: p.reason ?? 'OFFICER', frozenAt } : c.state === 'PAUSED' && p.reason ? { pausedReason: p.reason } : undefined;
            case 'SendResumed':
              return c.state === 'PAUSED' ? { state: 'SENDING', pausedReason: undefined } : undefined;
            case 'SendStopped':
              return c.state !== 'STOPPED' && c.state !== 'COMPLETED' ? { state: 'STOPPED' } : undefined;
            default:
              return c.state === 'SENDING' || c.state === 'PAUSED' ? { state: 'COMPLETED', pausedReason: undefined } : undefined;
          }
        });
        if (c && (c.state === 'STOPPED' || c.state === 'COMPLETED')) await release(p.teamId, c.listId, p.campaignId);
        return;
      }
      default:
        d.logger.info('event ignored', { type: e.type, eventId: e.eventId });
    }
  };
}


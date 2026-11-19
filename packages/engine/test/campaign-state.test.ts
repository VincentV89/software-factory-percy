import { describe, expect, it } from 'vitest';
import { InvalidTransition } from '@percy/shared';
import { CAMPAIGN_ACTIONS, CAMPAIGN_STATES, canTransition, transition, type CampaignAction, type CampaignState } from '../src/domain/campaign-state';

/** FR-CMP-02: the allowed transitions; every other (state, action) pair must be refused with 409. */
const ALLOWED: [CampaignState, CampaignAction, CampaignState][] = [
  ['DRAFT', 'submit', 'PENDING_APPROVAL'],
  ['PENDING_APPROVAL', 'approve', 'APPROVED'],
  ['PENDING_APPROVAL', 'reject', 'DRAFT'],
  ['DRAFT', 'edit', 'DRAFT'],
  ['PENDING_APPROVAL', 'edit', 'DRAFT'],
  ['APPROVED', 'edit', 'DRAFT'],
  ['APPROVED', 'schedule', 'SCHEDULED'],
  ['SCHEDULED', 'unschedule', 'APPROVED'],
  ['SCHEDULED', 'fire', 'FREEZING'],
  ['FREEZING', 'freezeCompleted', 'SENDING'],
  ['FREEZING', 'freezeFailed', 'APPROVED'],
  ['SENDING', 'pause', 'PAUSED'],
  ['PAUSED', 'resume', 'SENDING'],
  ['SENDING', 'stop', 'STOPPED'],
  ['PAUSED', 'stop', 'STOPPED'],
  ['SCHEDULED', 'stop', 'STOPPED'],
  ['FREEZING', 'stop', 'STOPPED'],
  ['SENDING', 'complete', 'COMPLETED'],
];

describe('campaign state machine (FR-CMP-02)', () => {
  const pairs = CAMPAIGN_STATES.flatMap((s) => CAMPAIGN_ACTIONS.map((a) => [s, a] as const));

  it('covers every (state, action) pair', () => {
    expect(pairs).toHaveLength(CAMPAIGN_STATES.length * CAMPAIGN_ACTIONS.length);
  });

  it.each(pairs)('%s + %s', (state, action) => {
    const allowed = ALLOWED.find(([s, a]) => s === state && a === action);
    if (allowed) {
      expect(transition(state, action)).toBe(allowed[2]);
      expect(canTransition(state, action)).toBe(true);
    } else {
      expect(() => transition(state, action)).toThrow(InvalidTransition);
      expect(canTransition(state, action)).toBe(false);
      try {
        transition(state, action);
      } catch (e) {
        expect((e as InvalidTransition).status).toBe(409);
      }
    }
  });

  it('STOPPED and COMPLETED are final', () => {
    for (const a of CAMPAIGN_ACTIONS) {
      expect(canTransition('STOPPED', a)).toBe(false);
      expect(canTransition('COMPLETED', a)).toBe(false);
    }
  });
});

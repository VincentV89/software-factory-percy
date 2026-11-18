import { InvalidTransition } from '@percy/shared';

/** Campaign states and the officer-action transition table (FR-CMP-02). */
export const CAMPAIGN_STATES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'FREEZING', 'SENDING', 'PAUSED', 'STOPPED', 'COMPLETED'] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];

export const CAMPAIGN_ACTIONS = ['submit', 'approve', 'reject', 'edit', 'schedule', 'unschedule', 'fire', 'freezeCompleted', 'freezeFailed', 'pause', 'resume', 'stop', 'complete'] as const;
export type CampaignAction = (typeof CAMPAIGN_ACTIONS)[number];

const TABLE: Record<CampaignState, Partial<Record<CampaignAction, CampaignState>>> = {
  DRAFT: { submit: 'PENDING_APPROVAL', edit: 'DRAFT' },
  PENDING_APPROVAL: { approve: 'APPROVED', reject: 'DRAFT', edit: 'DRAFT' },
  APPROVED: { edit: 'DRAFT', schedule: 'SCHEDULED' },
  SCHEDULED: { unschedule: 'APPROVED', fire: 'FREEZING', stop: 'STOPPED' },
  FREEZING: { freezeCompleted: 'SENDING', freezeFailed: 'APPROVED', stop: 'STOPPED' },
  SENDING: { pause: 'PAUSED', stop: 'STOPPED', complete: 'COMPLETED' },
  PAUSED: { resume: 'SENDING', stop: 'STOPPED' },
  STOPPED: {},
  COMPLETED: {},
};

/** Pure transition: returns the next state or throws InvalidTransition (HTTP 409). */
export function transition(state: CampaignState, action: CampaignAction): CampaignState {
  const next = TABLE[state][action];
  if (!next) throw new InvalidTransition(`A campaign in state ${state} cannot ${describe(action)}.`);
  return next;
}

export function canTransition(state: CampaignState, action: CampaignAction): boolean {
  return TABLE[state][action] !== undefined;
}

function describe(action: CampaignAction): string {
  const words: Record<CampaignAction, string> = {
    submit: 'be submitted for approval',
    approve: 'be approved',
    reject: 'be rejected',
    edit: 'be edited',
    schedule: 'be scheduled',
    unschedule: 'be unscheduled',
    fire: 'start freezing its audience',
    freezeCompleted: 'start sending',
    freezeFailed: 'return to approved',
    pause: 'be paused',
    resume: 'be resumed',
    stop: 'be stopped',
    complete: 'be completed',
  };
  return words[action];
}

/** States in which the campaign holds its list (FR-CON-01). */
export const HOLDING_STATES: CampaignState[] = ['SCHEDULED', 'FREEZING', 'SENDING', 'PAUSED'];
/** States the SPA polls the report in (FR-RPT-02). */
export const LIVE_STATES: CampaignState[] = ['FREEZING', 'SENDING', 'PAUSED'];

import { z } from 'zod';
import { CampaignService } from '../campaigns';
import { engineCpRuntime } from './runtime';

const deps = engineCpRuntime('engine-schedule-fire');
const campaigns = new CampaignService(deps);
const input = z.object({ teamId: z.string(), campaignId: z.string() });

/** EventBridge Scheduler target: schedule time reached (SCHEDULED → FREEZING). */
export async function handler(event: unknown): Promise<void> {
  const { teamId, campaignId } = input.parse(event);
  const c = await campaigns.fire(teamId, campaignId);
  deps.logger.info('schedule fired', { campaignId, state: c.state });
}

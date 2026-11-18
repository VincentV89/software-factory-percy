import { GetAccountCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { CloudWatchMetrics } from '@percy/shared/aws';
import { createLogger } from '@percy/shared';

const ses = new SESv2Client({});
const metrics = new CloudWatchMetrics('Percy');
const logger = createLogger('ses-quota-probe');

/** Publishes SesQuotaUsedPct every 5 minutes; SES has no native quota-used metric (NFR-OPS-01). */
export async function handler(): Promise<{ usedPct: number }> {
  const out = await ses.send(new GetAccountCommand({}));
  const max = out.SendQuota?.Max24HourSend ?? 0;
  const sent = out.SendQuota?.SentLast24Hours ?? 0;
  const usedPct = max > 0 ? Math.round((sent / max) * 1000) / 10 : 0;
  await metrics.put('SesQuotaUsedPct', usedPct, { instance: process.env['PERCY_INSTANCE'] ?? 'unknown' });
  logger.info('ses quota', { usedPct, max, sent });
  return { usedPct };
}

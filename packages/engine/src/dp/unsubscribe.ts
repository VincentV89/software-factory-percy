import { rawBody, type ApiEvent, type ApiResult } from '@percy/shared';
import type { SuppressionRequest } from '@percy/contactsg-contract';
import { escapeHtml } from '../domain/template';
import { verifyUnsubscribeToken } from '../domain/unsubscribe-token';
import { eventOp, loadSpec, type EngineDpDeps } from './deps';

const CSP = "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function page(status: number, title: string, body: string): ApiResult {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
  return {
    statusCode: status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' },
    body: html,
  };
}

const invalid = (): ApiResult => page(400, 'This link is not valid', '<p>This unsubscribe link is not valid. If you keep receiving email you did not ask for, contact the sender.</p>');

/**
 * Citizen unsubscribe on percy-dp (FR-UNS-01..04). No session. GET shows a confirmation page that
 * names the agency; POST (form or RFC 8058 one-click) records an AGENCY suppression and always
 * returns the same success page.
 */
export function createUnsubscribeHandler(d: EngineDpDeps) {
  return async function handle(event: ApiEvent): Promise<ApiResult> {
    const token = decodeURIComponent(event.path.split('/').pop() ?? '');
    const claims = verifyUnsubscribeToken(token, await d.unsubscribeKeys());
    if (!claims) return invalid();
    const spec = await loadSpec(d, claims.campaignId).catch(() => undefined);
    const agencyName = spec && spec.agencyId === claims.agencyId ? spec.agencyName : 'the sender';
    if (event.httpMethod === 'GET') {
      return page(
        200,
        'Unsubscribe',
        `<p>Stop receiving email from <strong data-testid="unsubscribe-agency">${escapeHtml(agencyName)}</strong>?</p><form method="post"><input type="hidden" name="confirm" value="yes"><button type="submit" data-testid="unsubscribe-confirm">Unsubscribe</button></form>`,
      );
    }
    if (event.httpMethod !== 'POST') return invalid();
    const body = rawBody(event);
    if (body.length > 2048) return invalid();
    const request: SuppressionRequest = { addrHash: claims.addrHash, scope: 'AGENCY', agencyId: claims.agencyId, reason: 'UNSUBSCRIBE', sourceCampaignId: claims.campaignId };
    await d.kv.transact([eventOp(d, 'SuppressionRequested', request)]);
    d.logger.info('unsubscribe recorded', { campaignId: claims.campaignId, agencyId: claims.agencyId, addrHash: claims.addrHash });
    return page(200, 'You have been unsubscribed', `<p data-testid="unsubscribe-success">You will no longer receive email from ${escapeHtml(agencyName)} sent through Percy.</p>`);
  };
}

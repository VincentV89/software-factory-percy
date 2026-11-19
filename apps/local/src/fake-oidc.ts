import { base64url, fromBase64url, randomToken, Unauthenticated } from '@percy/shared';
import type { OidcClient } from '@percy/platform';

/**
 * Local stand-in for the Cognito hosted UI. The authorize URL points at a local sign-in page; the
 * "ID token" is an unsigned JSON blob that is only ever accepted by this fake. Never used in AWS.
 */
export class FakeOidc implements OidcClient {
  private codes = new Map<string, { email: string; nonce: string; challenge: string }>();

  constructor(private readonly baseUrl: string) {}

  async authorizeUrl(p: { state: string; nonce: string; codeChallenge: string; redirectUri: string }): Promise<string> {
    await Promise.resolve();
    const q = new URLSearchParams({ state: p.state, nonce: p.nonce, code_challenge: p.codeChallenge, redirect_uri: p.redirectUri });
    return `${this.baseUrl}/_local/oidc/authorize?${q.toString()}`;
  }

  /** Called by the local sign-in page when the user picks an identity. */
  issueCode(email: string, nonce: string, challenge: string): string {
    const code = randomToken(16);
    this.codes.set(code, { email: email.trim().toLowerCase(), nonce, challenge });
    return code;
  }

  async exchangeCode(code: string, verifier: string): Promise<{ idToken: string }> {
    await Promise.resolve();
    const entry = this.codes.get(code);
    this.codes.delete(code);
    const { createHash } = await import('node:crypto');
    if (!entry || base64url(createHash('sha256').update(verifier).digest()) !== entry.challenge) throw new Unauthenticated('Sign-in could not be completed.');
    return { idToken: base64url(JSON.stringify({ sub: `local-${entry.email}`, email: entry.email, nonce: entry.nonce })) };
  }

  async verifyIdToken(idToken: string, nonce: string): Promise<{ sub: string; email: string }> {
    await Promise.resolve();
    const claims = JSON.parse(fromBase64url(idToken)) as { sub: string; email: string; nonce: string };
    if (claims.nonce !== nonce) throw new Unauthenticated('Sign-in could not be verified.');
    return { sub: claims.sub, email: claims.email };
  }

  async logoutUrl(returnTo: string): Promise<string> {
    await Promise.resolve();
    return returnTo;
  }
}

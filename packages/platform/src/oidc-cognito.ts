import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Unauthenticated, cached, type SecretStore } from '@percy/shared';
import type { OidcClient } from './bff';

export interface CognitoConfig {
  /** Hosted UI base, e.g. https://percy-dev.auth.ap-southeast-1.amazoncognito.com */
  domainUrl: string;
  /** https://cognito-idp.<region>.amazonaws.com/<poolId> */
  issuer: string;
  /** Secrets Manager id of `{ clientId, clientSecret }`, written by EdgeStack (ADR-12). */
  clientSecretId: string;
}

interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

/** Cognito hosted UI over OIDC authorization code + PKCE. The client secret never leaves the BFF. */
export class CognitoOidcClient implements OidcClient {
  private readonly jwks;
  private readonly credentials: () => Promise<ClientCredentials>;

  constructor(private readonly cfg: CognitoConfig, secrets: SecretStore) {
    this.jwks = createRemoteJWKSet(new URL(`${cfg.issuer}/.well-known/jwks.json`));
    this.credentials = cached(async () => JSON.parse(await secrets.getSecret(cfg.clientSecretId)) as ClientCredentials, 5 * 60_000);
  }

  async authorizeUrl(p: { state: string; nonce: string; codeChallenge: string; redirectUri: string }): Promise<string> {
    const { clientId } = await this.credentials();
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: p.redirectUri,
      scope: 'openid email',
      state: p.state,
      nonce: p.nonce,
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${this.cfg.domainUrl}/oauth2/authorize?${q.toString()}`;
  }

  async exchangeCode(code: string, verifier: string, redirectUri: string): Promise<{ idToken: string }> {
    const { clientId, clientSecret } = await this.credentials();
    const res = await fetch(`${this.cfg.domainUrl}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }).toString(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Unauthenticated('Sign-in could not be completed.');
    const body = (await res.json()) as { id_token?: string };
    if (!body.id_token) throw new Unauthenticated('Sign-in could not be completed.');
    return { idToken: body.id_token };
  }

  async verifyIdToken(idToken: string, nonce: string): Promise<{ sub: string; email: string }> {
    const { clientId } = await this.credentials();
    const { payload } = await jwtVerify(idToken, this.jwks, { issuer: this.cfg.issuer, audience: clientId });
    if (payload['nonce'] !== nonce || payload['token_use'] !== 'id') throw new Unauthenticated('Sign-in could not be verified.');
    const email = payload['email'];
    if (typeof email !== 'string' || typeof payload.sub !== 'string') throw new Unauthenticated('Sign-in could not be verified.');
    return { sub: payload.sub, email };
  }

  async logoutUrl(returnTo: string): Promise<string> {
    const { clientId } = await this.credentials();
    return `${this.cfg.domainUrl}/logout?${new URLSearchParams({ client_id: clientId, logout_uri: returnTo }).toString()}`;
  }
}

export interface SesIdentity {
  name: string;
  type: 'EMAIL_ADDRESS' | 'DOMAIN';
  status: string;
  verified: boolean;
}

export interface VerificationSnapshot {
  region: string;
  checkedAt: string;
  identities: SesIdentity[];
}

export interface RecipientVerification {
  snapshot(): Promise<VerificationSnapshot>;
}

export interface RecipientStatus {
  allowed: boolean;
  status: string;
  identity?: string;
}

/** Build indexes once per SES read, so large lists do not scan every identity per recipient. */
export function createRecipientVerifier(snapshot: VerificationSnapshot): (email: string) => RecipientStatus {
  const emails = new Map(snapshot.identities.filter((identity) => identity.type === 'EMAIL_ADDRESS').map((identity) => [identity.name.toLowerCase(), identity]));
  const domains = new Map(snapshot.identities.filter((identity) => identity.type === 'DOMAIN').map((identity) => [identity.name.toLowerCase(), identity]));
  return (email) => {
    const normalized = email.trim().toLowerCase();
    const at = normalized.lastIndexOf('@');
    if (at <= 0 || normalized.indexOf('@') !== at) return { allowed: false, status: 'NOT_VERIFIED' };
    let domain = normalized.slice(at + 1);
    if (domain === 'simulator.amazonses.com') return { allowed: true, status: 'SIMULATOR' };
    const exact = emails.get(normalized);
    if (exact?.verified) return { allowed: true, status: 'VERIFIED_EMAIL', identity: exact.name };
    let unverified = exact;
    // SES domain verification covers subdomains; label traversal enforces a dot boundary.
    while (domain) {
      const identity = domains.get(domain);
      if (identity?.verified) return { allowed: true, status: 'VERIFIED_DOMAIN', identity: identity.name };
      unverified ??= identity;
      const dot = domain.indexOf('.');
      domain = dot < 0 ? '' : domain.slice(dot + 1);
    }
    return { allowed: false, status: unverified?.status === 'SUCCESS' ? 'NOT_VERIFIED' : unverified?.status ?? 'NOT_VERIFIED', identity: unverified?.name };
  };
}

export function recipientStatus(email: string, snapshot: VerificationSnapshot): RecipientStatus {
  return createRecipientVerifier(snapshot)(email);
}

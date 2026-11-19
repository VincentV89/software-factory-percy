import { NagSuppressions } from 'cdk-nag';
import type { IConstruct } from 'constructs';

export interface Suppression {
  id: string;
  reason: string;
  appliesTo?: string[];
}

/** Every cdk-nag suppression goes through here and must carry a written reason (NFR-INF-03). */
export function suppress(scope: IConstruct, suppressions: Suppression[], applyToChildren = true): void {
  for (const s of suppressions) {
    if (!s.reason || s.reason.trim().length < 20) throw new Error(`cdk-nag suppression ${s.id} needs a written reason of at least 20 characters`);
  }
  NagSuppressions.addResourceSuppressions(scope, suppressions.map((s) => ({ id: s.id, reason: s.reason, appliesTo: s.appliesTo })), applyToChildren);
}

export function suppressStack(scope: IConstruct, suppressions: Suppression[]): void {
  for (const s of suppressions) {
    if (!s.reason || s.reason.trim().length < 20) throw new Error(`cdk-nag suppression ${s.id} needs a written reason of at least 20 characters`);
  }
  NagSuppressions.addStackSuppressions(scope as never, suppressions.map((s) => ({ id: s.id, reason: s.reason, appliesTo: s.appliesTo })));
}

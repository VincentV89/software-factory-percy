import { describe, expect, it } from 'vitest';
import { DDB_WRITE, grants, resolveRef, roleInfo, templates } from './helpers';

/**
 * Template architecture tests (NFR-SEC-02, NFR-ARC-02): read the synthesised templates and fail
 * on a second writer context for any table, or on any data-plane path into the control plane.
 */
describe('template architecture', () => {
  const all = templates('dev');
  const allGrants = grants(all);

  const tables = all.flatMap((st) =>
    Object.entries(st.json.Resources)
      .filter(([, r]) => r.Type === 'AWS::DynamoDB::Table')
      .map(([logicalId, r]) => ({ stack: st.name, logicalId, name: String(r.Properties?.['TableName']) })),
  );

  const writersOf = (t: { stack: string; logicalId: string }) =>
    allGrants.filter((g) => g.actions.some((a) => DDB_WRITE.includes(a)) && g.resources.some((r) => {
      const ref = resolveRef(r, g.stack, all);
      return ref?.stack === t.stack && ref.logicalId === t.logicalId;
    }));

  it('finds all twelve tables', () => {
    expect(tables.map((t) => t.name.replace('percy-dev-', '')).sort()).toEqual(
      ['contactsg-contacts', 'contactsg-freezes', 'contactsg-imports', 'contactsg-outbox', 'contactsg-suppressions', 'engine-campaigns', 'engine-outbox', 'engine-sendgate', 'engine-sendlog', 'platform-outbox', 'platform-sessions', 'platform-tenancy'].sort(),
    );
  });

  it.each(tables.map((t) => [t.name, t] as const))('%s has exactly one writer context', (_name, t) => {
    const writers = writersOf(t);
    expect(writers.length).toBeGreaterThan(0);
    const contexts = new Set(writers.map((w) => w.role.context));
    expect([...contexts]).toHaveLength(1);
    expect(contexts.has(undefined)).toBe(false);
    expect(writers.every((w) => w.role.stack === t.stack)).toBe(true);
  });

  it('every Engine table has exactly one writer plane', () => {
    for (const t of tables.filter((x) => x.name.includes('-engine-'))) {
      const planes = new Set(writersOf(t).map((w) => w.role.plane));
      expect([...planes], t.name).toHaveLength(1);
    }
    const campaigns = tables.find((t) => t.name.endsWith('engine-campaigns'));
    expect(campaigns && [...new Set(writersOf(campaigns).map((w) => w.role.plane))]).toEqual(['cp']);
  });

  const dpGrants = allGrants.filter((g) => g.role.context === 'engine' && g.role.plane === 'dp');

  it('no data-plane role may call percy-cp', () => {
    expect(dpGrants.length).toBeGreaterThan(10);
    expect(dpGrants.filter((g) => g.actions.some((a) => a.startsWith('execute-api:')))).toEqual([]);
  });

  it('no data-plane role may invoke a control-plane function', () => {
    const offenders = dpGrants.filter((g) => g.actions.some((a) => a === 'lambda:InvokeFunction' || a === 'lambda:*')).filter((g) =>
      g.resources.some((r) => {
        const ref = resolveRef(r, g.stack, all);
        const st = all.find((x) => x.name === ref?.stack);
        const fn = ref && st?.json.Resources[ref.logicalId];
        if (!fn || fn.Type !== 'AWS::Lambda::Function' || !st) return false;
        const roleRef = resolveRef(fn.Properties?.['Role'], st, all);
        return roleRef ? roleInfo(all.find((x) => x.name === roleRef.stack) ?? st, roleRef.logicalId).plane !== 'dp' : true;
      }),
    );
    expect(offenders.map((o) => o.role.logicalId)).toEqual([]);
  });

  it('no role outside Firehose can delete or overwrite audit objects', () => {
    const foundation = all.find((s) => s.name === 'percy-dev-foundation');
    const auditId = Object.entries(foundation?.json.Resources ?? {}).find(([id, r]) => r.Type === 'AWS::S3::Bucket' && id.startsWith('AuditBucket'))?.[0];
    const offenders = allGrants.filter(
      (g) => g.actions.some((a) => a.startsWith('s3:DeleteObject') || a === 's3:PutObject' || a === 's3:*') && g.resources.some((r) => resolveRef(r, g.stack, all)?.logicalId === auditId) && !g.role.logicalId.startsWith('AuditFirehoseRole'),
    );
    expect(auditId).toBeDefined();
    expect(offenders.map((o) => o.role.logicalId)).toEqual([]);
  });

  it('every Percy Lambda role is tagged with context and plane', () => {
    for (const st of all) {
      for (const [id, r] of Object.entries(st.json.Resources)) {
        if (r.Type !== 'AWS::Lambda::Function') continue;
        const roleRef = resolveRef(r.Properties?.['Role'], st, all);
        if (!roleRef) continue;
        const info = roleInfo(st, roleRef.logicalId);
        const isCdkHelper = /CustomResource|AutoDelete|BucketDeployment|LogRetention|AWS[0-9a-f]{20,}|SingletonLambda|Provider/i.test(id) || !info.context;
        if (isCdkHelper && !st.json.Resources[id]?.Properties?.['Environment']) continue;
        if (isCdkHelper) continue;
        expect(info.plane, `${st.name}/${id}`).toBeDefined();
      }
    }
  });
});

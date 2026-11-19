/**
 * Bounded-context import rules (NFR-ARC-01..03, design section 3).
 * Run with: depcruise packages apps --config .dependency-cruiser.cjs
 */
module.exports = {
  forbidden: [
    {
      name: 'contactsg-never-imports-engine',
      comment: 'NFR-ARC-03: ContactSG must not depend on Campaign Engine code.',
      severity: 'error',
      from: { path: '^packages/contactsg' },
      to: { path: '^packages/engine' },
    },
    {
      name: 'engine-dp-not-cp',
      comment: 'D-02: the data plane never imports control-plane code.',
      severity: 'error',
      from: { path: '^packages/engine/src/dp/' },
      to: { path: '^packages/engine/src/(cp|sendlog-read)/' },
    },
    {
      name: 'engine-cp-not-dp',
      comment: 'D-02: the control plane never imports data-plane code.',
      severity: 'error',
      from: { path: '^packages/engine/src/(cp|sendlog-read)/' },
      to: { path: '^packages/engine/src/dp/' },
    },
    {
      name: 'domain-is-pure',
      comment: 'Domain code imports nothing from the AWS SDK.',
      severity: 'error',
      from: { path: '^packages/[^/]+/src/domain/' },
      to: { path: '@aws-sdk' },
    },
    {
      name: 'contexts-only-through-contracts',
      comment: 'NFR-ARC-01: a context imports another context only through its -contract package (or integrations-ses).',
      severity: 'error',
      from: { path: '^packages/(platform|contactsg|engine)/' },
      to: {
        path: '^packages/(platform|contactsg|engine)/',
        pathNot: ['^packages/$1/', '^packages/[^/]+-contract/'],
      },
    },
    {
      name: 'contracts-are-thin',
      comment: 'Contract packages import only @percy/shared, zod and AWS SDK clients.',
      severity: 'error',
      from: { path: '^packages/([^/]+-contract)/' },
      to: { path: '^packages/', pathNot: ['^packages/shared/', '^packages/$1/'] },
    },
    {
      name: 'shared-has-no-domain',
      comment: 'The shared kernel imports no context.',
      severity: 'error',
      from: { path: '^packages/shared/' },
      to: { path: '^packages/(?!shared/)' },
    },
    {
      name: 'packages-never-import-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(node_modules|dist|cdk\\.out)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    combinedDependencies: true,
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default', 'types'], extensions: ['.ts', '.tsx', '.js', '.json'] },
  },
};

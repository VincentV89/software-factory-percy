import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { SPA_CSP } from '../src/stacks/edge-stack';
import { app, templates } from './helpers';

const byName = (name: string, instance = 'dev') => {
  const t = templates(instance).find((s) => s.name === name);
  if (!t) throw new Error(`no stack ${name}`);
  return t;
};

describe('CDK assertions (dev)', () => {
  it('snapshot bucket expires objects after 7 days (FR-SCH-05)', () => {
    byName('percy-dev-contactsg').template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ Id: 'snapshot-retention', ExpirationInDays: 7, Status: 'Enabled' })]) },
    });
  });

  it('upload bucket expires raw/, chunks/ and quarantine/', () => {
    byName('percy-dev-contactsg').template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Prefix: 'raw/', ExpirationInDays: 2 }),
          Match.objectLike({ Prefix: 'chunks/', ExpirationInDays: 2 }),
          Match.objectLike({ Prefix: 'quarantine/', ExpirationInDays: 1 }),
        ]),
      },
    });
  });

  it('audit bucket: 365-day retention, versioning, deny-delete policy (FR-AUD-02/03)', () => {
    const t = byName('percy-dev-foundation').template;
    t.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ Id: 'audit-retention', ExpirationInDays: 365 })]) },
    });
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Sid: 'DenyAuditDeletion', Effect: 'Deny', Principal: { AWS: '*' }, Action: Match.arrayWith(['s3:DeleteObject*']) })]) },
    });
    t.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', { DeliveryStreamEncryptionConfigurationInput: { KeyType: 'CUSTOMER_MANAGED_CMK' } });
  });

  it('Object Lock is prod-only', () => {
    expect(JSON.stringify(byName('percy-dev-foundation').json)).not.toContain('ObjectLockConfiguration');
    expect(JSON.stringify(byName('percy-prod-foundation', 'prod').json)).toContain('ObjectLockConfiguration');
  });

  it('three context CMKs with rotation (NFR-SEC-01)', () => {
    const t = byName('percy-dev-foundation').template;
    t.resourceCountIs('AWS::KMS::Key', 3);
    t.allResourcesProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  });

  it('every table uses a CMK, PITR, and on-demand billing', () => {
    for (const st of templates('dev')) {
      for (const r of Object.values(st.json.Resources).filter((x) => x.Type === 'AWS::DynamoDB::Table')) {
        expect(r.Properties?.['SSESpecification']).toMatchObject({ SSEEnabled: true, SSEType: 'KMS' });
        expect(r.Properties?.['PointInTimeRecoverySpecification']).toEqual({ PointInTimeRecoveryEnabled: true });
        expect(r.Properties?.['BillingMode']).toBe('PAY_PER_REQUEST');
      }
    }
  });

  it('WAF: managed rule sets and rate limits on CloudFront and the regional APIs (NFR-SEC-04)', () => {
    for (const [stack, scope] of [['percy-dev-edgewaf', 'CLOUDFRONT'], ['percy-dev-edge', 'REGIONAL']] as const) {
      byName(stack).template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Scope: scope,
        Rules: Match.arrayWith([
          Match.objectLike({ Statement: { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: 'AWSManagedRulesCommonRuleSet' } } }),
          Match.objectLike({ Statement: { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: 'AWSManagedRulesKnownBadInputsRuleSet' } } }),
          Match.objectLike({ Statement: { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: 'AWSManagedRulesAmazonIpReputationList' } } }),
          Match.objectLike({ Name: 'RateUnsubscribe', Statement: { RateBasedStatement: Match.objectLike({ Limit: 300, AggregateKeyType: 'IP' }) } }),
          Match.objectLike({ Name: 'RateDefault', Statement: { RateBasedStatement: Match.objectLike({ Limit: 2000 }) } }),
        ]),
      });
    }
    byName('percy-dev-edge').template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 2);
  });

  it('CloudFront security headers (NFR-SEC-06)', () => {
    expect(SPA_CSP).not.toContain("'unsafe-inline'");
    expect(SPA_CSP).toContain("frame-ancestors 'none'");
    byName('percy-dev-edge').template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: {
        SecurityHeadersConfig: {
          ContentSecurityPolicy: { ContentSecurityPolicy: SPA_CSP, Override: true },
          StrictTransportSecurity: Match.objectLike({ AccessControlMaxAgeSec: 31536000, Override: true }),
          ContentTypeOptions: { Override: true },
          ReferrerPolicy: { ReferrerPolicy: 'same-origin', Override: true },
          FrameOptions: { FrameOption: 'DENY', Override: true },
        },
      },
    });
  });

  it('CloudFront routes /api/*, /auth/* and /u/* and attaches the web ACL', () => {
    const dist = Object.values(byName('percy-dev-edge').json.Resources).find((r) => r.Type === 'AWS::CloudFront::Distribution');
    const cfg = dist?.Properties?.['DistributionConfig'] as { CacheBehaviors: { PathPattern: string }[]; WebACLId: unknown };
    expect(cfg.CacheBehaviors.map((b) => b.PathPattern).sort()).toEqual(['/api/*', '/auth/*', '/u/*']);
    expect(cfg.WebACLId).toBeDefined();
  });

  it('send workers: reserved concurrency 5 per tier; percy-cp throttled at 50 rps (NFR-INF-07)', () => {
    const engine = byName('percy-dev-engine');
    const workers = Object.entries(engine.json.Resources).filter(([id, r]) => r.Type === 'AWS::Lambda::Function' && id.startsWith('SendWorker'));
    expect(workers).toHaveLength(2);
    for (const [, w] of workers) expect(w.Properties?.['ReservedConcurrentExecutions']).toBe(5);
    byName('percy-dev-edge').template.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: Match.arrayWith([Match.objectLike({ ThrottlingRateLimit: 50, HttpMethod: '*', ResourcePath: '/*' })]),
    });
  });

  it('worker queues: visibility 6 × the 900 s function timeout; batch size 1 with partial failures', () => {
    const engine = byName('percy-dev-engine').template;
    engine.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'percy-dev-send-batches-standard', VisibilityTimeout: 5400 });
    engine.hasResourceProperties('AWS::Lambda::EventSourceMapping', { BatchSize: 1, FunctionResponseTypes: ['ReportBatchItemFailures'] });
    engine.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'percy-dev-send-commands.fifo', FifoQueue: true });
  });

  it('dev resources are destroyable; prod retains (NFR-INF-06)', () => {
    for (const r of Object.values(byName('percy-dev-engine').json.Resources as Record<string, { Type: string; DeletionPolicy?: string }>)) {
      if (r.Type === 'AWS::DynamoDB::Table') expect(r.DeletionPolicy).toBe('Delete');
    }
    for (const r of Object.values(byName('percy-prod-engine', 'prod').json.Resources as Record<string, { Type: string; DeletionPolicy?: string; Properties?: Record<string, unknown> }>)) {
      if (r.Type === 'AWS::DynamoDB::Table') {
        expect(r.DeletionPolicy).toBe('Retain');
        expect(r.Properties?.['DeletionProtectionEnabled']).toBe(true);
      }
    }
  });

  it('the dev-only send-log export exists only on dev (U7)', () => {
    const fnEnv = (instance: string) => {
      const engine = byName(`percy-${instance}-engine`, instance);
      const api = Object.entries(engine.json.Resources).find(([id, r]) => r.Type === 'AWS::Lambda::Function' && id.startsWith('EngineApi'));
      return (api?.[1].Properties?.['Environment'] as { Variables: Record<string, string> }).Variables;
    };
    expect(fnEnv('dev')['DEV_EXPORT']).toBe('true');
    expect(fnEnv('prod')['DEV_EXPORT']).toBe('false');
    expect(fnEnv('prod')['ADDRESS_ALLOW_LIST']).toBeUndefined();
    const prodEdge = JSON.stringify(byName('percy-prod-edge', 'prod').json);
    expect(prodEdge).toContain('"PathPart":"test"');
    expect(JSON.stringify(byName('percy-dev-edge').json)).not.toContain('"PathPart":"test"');
  });

  it('the authorizer never caches (ADR-02)', () => {
    byName('percy-dev-edge').template.hasResourceProperties('AWS::ApiGateway::Authorizer', { Type: 'REQUEST', AuthorizerResultTtlInSeconds: 0 });
  });

  it('alarms: DLQs, worker errors, SES reputation, quota and circuit breaker (NFR-OPS-01)', () => {
    const engine = byName('percy-dev-engine');
    const alarms = Object.values(engine.json.Resources).filter((r) => r.Type === 'AWS::CloudWatch::Alarm').map((r) => r.Properties ?? {});
    const metrics = alarms.map((a) => String(a['MetricName']));
    expect(metrics).toEqual(expect.arrayContaining(['ApproximateNumberOfMessagesVisible', 'Errors', 'Reputation.BounceRate', 'Reputation.ComplaintRate', 'SesQuotaUsedPct', 'CircuitBreakerPaused']));
    expect(alarms.filter((a) => a['MetricName'] === 'ApproximateNumberOfMessagesVisible').length).toBe(8);
    expect(alarms.find((a) => a['MetricName'] === 'Reputation.BounceRate')?.['Threshold']).toBe(0.05);
    expect(alarms.find((a) => a['MetricName'] === 'Reputation.ComplaintRate')?.['Threshold']).toBe(0.001);
  });

  it('X-Ray tracing on every Percy Lambda and state machine (NFR-OPS-02)', () => {
    for (const st of templates('dev')) {
      for (const [id, r] of Object.entries(st.json.Resources)) {
        if (r.Type === 'AWS::StepFunctions::StateMachine') expect(r.Properties?.['TracingConfiguration'], id).toEqual({ Enabled: true });
        if (r.Type === 'AWS::Lambda::Function' && (r.Properties?.['Environment'] as { Variables?: Record<string, string> } | undefined)?.Variables?.['PERCY_INSTANCE']) {
          expect(r.Properties?.['TracingConfig'], id).toEqual({ Mode: 'Active' });
        }
      }
    }
  });

  it('no VPC, EC2 or containers (NFR-OPS-03)', () => {
    for (const st of templates('dev')) {
      const types = Object.values(st.json.Resources).map((r) => r.Type);
      expect(types.filter((t) => /^AWS::(EC2|ECS|EKS|RDS)::/.test(t))).toEqual([]);
    }
  });

  it('secrets are never in Lambda environment variables (NFR-SEC-05)', () => {
    for (const st of templates('dev')) {
      for (const r of Object.values(st.json.Resources)) {
        if (r.Type !== 'AWS::Lambda::Function') continue;
        const vars = JSON.stringify((r.Properties?.['Environment'] as { Variables?: unknown } | undefined)?.Variables ?? {});
        expect(vars).not.toMatch(/SecretString|clientSecret|"k1"/);
      }
    }
  });
});

describe('cdk-nag (NFR-INF-03)', () => {
  it.each(['dev', 'prod'])('%s has zero unsuppressed AwsSolutions errors', (instance) => {
    const a = app(instance);
    for (const s of [a.account, a.foundation, a.contactsg, a.engine, a.edgeWaf, a.edge]) {
      const errors = Annotations.fromStack(s).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
      expect(errors.map((e) => `${e.id}: ${String(e.entry.data).slice(0, 120)}`)).toEqual([]);
    }
  });

  it('every suppression carries a written reason', () => {
    for (const st of templates('dev')) {
      for (const r of Object.values(st.json.Resources) as { Metadata?: { cdk_nag?: { rules_to_suppress?: { id: string; reason: string }[] } } }[]) {
        for (const s of r.Metadata?.cdk_nag?.rules_to_suppress ?? []) expect(s.reason.length, s.id).toBeGreaterThanOrEqual(20);
      }
    }
  });
});

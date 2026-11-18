import { Stack, type StackProps } from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import type { InstanceConfig } from '../config';

/** AWS managed rule groups plus rate rules (NFR-SEC-04). Shared by the CloudFront and regional ACLs. */
export function webAclRules(cfg: InstanceConfig, prefix: string, unsubscribePath = '/u/'): wafv2.CfnWebACL.RuleProperty[] {
  const managed = (name: string, priority: number): wafv2.CfnWebACL.RuleProperty => ({
    name,
    priority,
    overrideAction: { none: {} },
    statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
    visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `${prefix}-${name}`, sampledRequestsEnabled: true },
  });
  return [
    managed('AWSManagedRulesCommonRuleSet', 10),
    managed('AWSManagedRulesKnownBadInputsRuleSet', 20),
    managed('AWSManagedRulesAmazonIpReputationList', 30),
    {
      name: 'RateUnsubscribe',
      priority: 40,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit: cfg.wafRateLimits.unsubscribe,
          aggregateKeyType: 'IP',
          evaluationWindowSec: 300,
          scopeDownStatement: { byteMatchStatement: { fieldToMatch: { uriPath: {} }, positionalConstraint: 'STARTS_WITH', searchString: unsubscribePath, textTransformations: [{ priority: 0, type: 'NONE' }] } },
        },
      },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `${prefix}-rate-unsubscribe`, sampledRequestsEnabled: true },
    },
    {
      name: 'RateDefault',
      priority: 50,
      action: { block: {} },
      statement: { rateBasedStatement: { limit: cfg.wafRateLimits.default, aggregateKeyType: 'IP', evaluationWindowSec: 300 } },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `${prefix}-rate-default`, sampledRequestsEnabled: true },
    },
  ];
}

/** EdgeWaf (us-east-1): the CloudFront web ACL. */
export class EdgeWafStack extends Stack {
  readonly webAclArn: string;

  constructor(scope: Construct, id: string, cfg: InstanceConfig, props: StackProps) {
    super(scope, id, props);
    const acl = new wafv2.CfnWebACL(this, 'CloudFrontAcl', {
      name: `percy-${cfg.instance}-cloudfront`,
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      rules: webAclRules(cfg, `percy-${cfg.instance}-cf`),
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `percy-${cfg.instance}-cloudfront`, sampledRequestsEnabled: true },
    });
    this.webAclArn = acl.attrArn;
  }
}

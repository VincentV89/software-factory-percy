import { App, Aspects, Tags, type AppProps } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { loadConfig, type InstanceConfig } from './config';
import { AccountStack } from './stacks/account-stack';
import { ContactSgStack } from './stacks/contactsg-stack';
import { EdgeStack } from './stacks/edge-stack';
import { EdgeWafStack } from './stacks/edgewaf-stack';
import { EngineStack } from './stacks/engine-stack';
import { FoundationStack } from './stacks/foundation-stack';

/** CDK feature flags this app relies on (also mirrored in cdk.json). */
export const FEATURE_FLAGS = {
  '@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy': true,
  '@aws-cdk/aws-iam:minimizePolicies': true,
  '@aws-cdk/aws-lambda-nodejs:useLatestRuntimeVersion': true,
  '@aws-cdk/core:defaultCrossStackReferences': 'strong',
};

export interface PercyApp {
  app: App;
  cfg: InstanceConfig;
  account: AccountStack;
  foundation: FoundationStack;
  contactsg: ContactSgStack;
  engine: EngineStack;
  edgeWaf: EdgeWafStack;
  edge: EdgeStack;
}

/** Builds every stack of advisory brief Appendix B for one instance (NFR-INF-01). No lookups (NFR-INF-02). */
export function buildApp(instance: string, appProps: AppProps = {}): PercyApp {
  const app = new App({ ...appProps, context: { ...FEATURE_FLAGS, ...(appProps.context ?? {}) } });
  const cfg = loadConfig(instance, { account: app.node.tryGetContext('account') as string | undefined, sesIdentity: app.node.tryGetContext('sesIdentity') as string | undefined });
  const env = { account: cfg.account, region: cfg.region };
  const stackName = (s: string) => `percy-${cfg.instance}-${s}`;
  const account = new AccountStack(app, 'percy-account', cfg, { env, stackName: 'percy-account', description: 'Percy per-account resources' });
  const foundation = new FoundationStack(app, stackName('foundation'), cfg, { env, description: 'Percy foundation: keys, Cognito, Platform, bus, audit' });
  foundation.addStackDependency(account);
  const contactsg = new ContactSgStack(app, stackName('contactsg'), cfg, foundation, { env, description: 'Percy ContactSG context' });
  const engine = new EngineStack(app, stackName('engine'), cfg, foundation, contactsg, { env, description: 'Percy Campaign Engine (cp + dp)' });
  const edgeWaf = new EdgeWafStack(app, stackName('edgewaf'), cfg, { env: { account: cfg.account, region: 'us-east-1' }, crossRegionReferences: true, description: 'Percy CloudFront WAF (us-east-1)' });
  const edge = new EdgeStack(app, stackName('edge'), { env, crossRegionReferences: true, cfg, foundation, contactsg, engine, cloudFrontWebAclArn: edgeWaf.webAclArn, description: 'Percy edge: APIs, SPA, CloudFront' });
  edge.addStackDependency(edgeWaf);
  Tags.of(app).add('percy:instance', cfg.instance);
  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  return { app, cfg, account, foundation, contactsg, engine, edgeWaf, edge };
}

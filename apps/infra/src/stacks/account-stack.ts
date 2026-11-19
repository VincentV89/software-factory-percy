import { Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ses from 'aws-cdk-lib/aws-ses';
import type { Construct } from 'constructs';
import type { InstanceConfig } from '../config';
import { suppress } from '../nag';

/** percy-account: per-account resources (SES identity, API Gateway CloudWatch role). */
export class AccountStack extends Stack {
  constructor(scope: Construct, id: string, cfg: InstanceConfig, props: StackProps) {
    super(scope, id, props);
    new ses.EmailIdentity(this, 'SenderIdentity', { identity: ses.Identity.email(cfg.sesIdentity) });
    const role = new iam.Role(this, 'ApiGatewayCloudWatchRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs')],
    });
    new apigw.CfnAccount(this, 'ApiGatewayAccount', { cloudWatchRoleArn: role.roleArn });
    suppress(role, [{ id: 'AwsSolutions-IAM4', reason: 'AmazonAPIGatewayPushToCloudWatchLogs is the AWS-documented policy for the account-level API Gateway logging role.' }]);
  }
}

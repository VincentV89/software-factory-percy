import { CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import type { CampaignScheduler } from './deps';

/** EventBridge Scheduler one-time schedules that delete themselves after firing. */
export class AwsCampaignScheduler implements CampaignScheduler {
  constructor(private readonly cfg: { group: string; targetArn: string; roleArn: string }, private readonly client = new SchedulerClient({})) {}

  async create(name: string, at: Date, payload: { teamId: string; campaignId: string }): Promise<void> {
    await this.client.send(
      new CreateScheduleCommand({
        Name: name.slice(0, 64),
        GroupName: this.cfg.group,
        ScheduleExpression: `at(${at.toISOString().slice(0, 19)})`,
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: 'OFF' },
        ActionAfterCompletion: 'DELETE',
        Target: { Arn: this.cfg.targetArn, RoleArn: this.cfg.roleArn, Input: JSON.stringify(payload), RetryPolicy: { MaximumRetryAttempts: 3 } },
      }),
    );
  }

  async delete(name: string): Promise<void> {
    try {
      await this.client.send(new DeleteScheduleCommand({ Name: name.slice(0, 64), GroupName: this.cfg.group }));
    } catch (e) {
      if ((e as { name?: string }).name !== 'ResourceNotFoundException') throw e;
    }
  }
}

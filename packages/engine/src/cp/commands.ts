import { newId, type QueueSender } from '@percy/shared';
import { commandGroupId, type SendCommand } from '@percy/engine-contract';

/** Sends a command to send-commands.fifo. The API calls this BEFORE writing campaign state (ADR-03). */
export async function sendCommand(queue: QueueSender, queueUrl: string, cmd: Omit<SendCommand, 'commandId' | 'issuedAt'>, now: number): Promise<SendCommand> {
  const full: SendCommand = { ...cmd, commandId: newId(now), issuedAt: new Date(now).toISOString() };
  await queue.send(queueUrl, { body: full, groupId: commandGroupId(full), dedupeId: full.commandId });
  return full;
}

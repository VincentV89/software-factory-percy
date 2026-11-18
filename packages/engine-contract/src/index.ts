import { z } from 'zod';

export const ENGINE_SOURCE = 'percy.engine';

export const gateScopeSchema = z.string().regex(/^(GLOBAL|AGENCY#[^#\s]+|TEAM#[^#\s]+)$/);
export type GateScope = z.infer<typeof gateScopeSchema>;

/** Message on send-commands.fifo (design 5.3). Group: CMP#<id> or GATE#<scope>; dedupe: commandId. */
export const sendCommandSchema = z.object({
  commandId: z.string(),
  type: z.enum(['PAUSE', 'RESUME', 'STOP', 'SET_GATE', 'CLEAR_GATE', 'RESEND']),
  campaignId: z.string().optional(),
  gateScope: gateScopeSchema.optional(),
  reason: z.string().optional(),
  issuedBy: z.string(),
  issuedAt: z.string(),
});
export type SendCommand = z.infer<typeof sendCommandSchema>;

export function commandGroupId(cmd: Pick<SendCommand, 'campaignId' | 'gateScope'>): string {
  return cmd.campaignId ? `CMP#${cmd.campaignId}` : `GATE#${cmd.gateScope ?? 'GLOBAL'}`;
}

/** Progress events from the data plane to the control plane (the only dp→cp channel, NFR-ARC-02). */
export const sendProgressSchema = z.object({
  campaignId: z.string(),
  teamId: z.string(),
  reason: z.string().optional(),
});
export type SendProgress = z.infer<typeof sendProgressSchema>;
export const SEND_EVENT_TYPES = ['SendStarted', 'SendPaused', 'SendResumed', 'SendStopped', 'SendCompleted'] as const;
export type SendEventType = (typeof SEND_EVENT_TYPES)[number];

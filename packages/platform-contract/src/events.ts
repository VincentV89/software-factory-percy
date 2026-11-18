import { z } from 'zod';

export const PLATFORM_SOURCE = 'percy.platform';

export const teamSuspendedSchema = z.object({ teamId: z.string(), agencyId: z.string(), reason: z.string(), by: z.string() });
export const teamReinstatedSchema = z.object({ teamId: z.string(), agencyId: z.string(), by: z.string() });
export const agencySuspendedSchema = z.object({ agencyId: z.string(), reason: z.string(), by: z.string() });
export const agencyReinstatedSchema = z.object({ agencyId: z.string(), by: z.string() });

export type PlatformEventType = 'TeamSuspended' | 'TeamReinstated' | 'AgencySuspended' | 'AgencyReinstated';

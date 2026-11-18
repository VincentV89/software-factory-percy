import { sweepInDoubt } from '../sweeper';
import { engineDpRuntime } from './runtime';

const deps = engineDpRuntime('engine-in-doubt-sweeper');

/** Runs every 5 minutes (EventBridge schedule). */
export async function handler(): Promise<{ marked: number }> {
  return { marked: await sweepInDoubt(deps) };
}

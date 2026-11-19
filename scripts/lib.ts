/** Shared helpers for deploy-time scripts. They run with an operator's AWS credentials, never in Lambda. */
export function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v !== undefined) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export const tableName = (instance: string, name: string): string => `percy-${instance}-${name}`;
export const auditStream = (instance: string): string => `percy-${instance}-audit`;

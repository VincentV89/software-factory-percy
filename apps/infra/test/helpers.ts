import { Template } from 'aws-cdk-lib/assertions';
import { buildApp, type PercyApp } from '../src/app';

/** Builds an instance without bundling Lambda code (assertion tests do not need the assets). */
const cache = new Map<string, PercyApp>();
export function app(instance = 'dev'): PercyApp {
  let a = cache.get(instance);
  if (!a) {
    a = buildApp(instance, { context: { 'aws:cdk:bundling-stacks': [] } });
    cache.set(instance, a);
  }
  return a;
}

export type Json = Record<string, unknown>;

export interface StackTemplate {
  name: string;
  json: { Resources: Record<string, { Type: string; Properties?: Json }>; Outputs?: Record<string, { Value: unknown; Export?: { Name: string } }> };
  template: Template;
}

export function templates(instance = 'dev'): StackTemplate[] {
  const a = app(instance);
  return [a.account, a.foundation, a.contactsg, a.engine, a.edgeWaf, a.edge].map((s) => {
    const template = Template.fromStack(s);
    return { name: s.stackName, template, json: template.toJSON() as StackTemplate['json'] };
  });
}

export interface ResourceRef {
  stack: string;
  logicalId: string;
}

/** Resolves Ref / Fn::GetAtt / Fn::ImportValue / Fn::Join (first reference) to the resource it names. */
export function resolveRef(value: unknown, stack: StackTemplate, all: StackTemplate[]): ResourceRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Json;
  if (typeof v['Ref'] === 'string') return { stack: stack.name, logicalId: v['Ref'] };
  if (Array.isArray(v['Fn::GetAtt'])) return { stack: stack.name, logicalId: String((v['Fn::GetAtt'] as unknown[])[0]) };
  if (v['Fn::ImportValue'] !== undefined) {
    const name = v['Fn::ImportValue'];
    for (const other of all) {
      for (const out of Object.values(other.json.Outputs ?? {})) {
        if (out.Export?.Name === name) return resolveRef(out.Value, other, all);
      }
    }
    return undefined;
  }
  if (Array.isArray(v['Fn::Join'])) {
    const parts = (v['Fn::Join'] as unknown[])[1];
    if (Array.isArray(parts)) for (const p of parts) {
      const r = resolveRef(p, stack, all);
      if (r) return r;
    }
  }
  return undefined;
}

export interface RoleInfo {
  stack: string;
  logicalId: string;
  context?: string;
  plane?: string;
}

export function roleInfo(stack: StackTemplate, logicalId: string): RoleInfo {
  const tags = (stack.json.Resources[logicalId]?.Properties?.['Tags'] as { Key: string; Value: string }[] | undefined) ?? [];
  return { stack: stack.name, logicalId, context: tags.find((t) => t.Key === 'percy:context')?.Value, plane: tags.find((t) => t.Key === 'percy:plane')?.Value };
}

export interface Grant {
  role: RoleInfo;
  actions: string[];
  resources: unknown[];
  stack: StackTemplate;
}

/** Every Allow statement attached to a role through an AWS::IAM::Policy. */
export function grants(all: StackTemplate[]): Grant[] {
  const out: Grant[] = [];
  for (const st of all) {
    for (const res of Object.values(st.json.Resources)) {
      if (res.Type !== 'AWS::IAM::Policy') continue;
      const roles = ((res.Properties?.['Roles'] as unknown[]) ?? []).map((r) => resolveRef(r, st, all)).filter((r): r is ResourceRef => !!r);
      const doc = res.Properties?.['PolicyDocument'] as { Statement: { Effect: string; Action: string | string[]; Resource: unknown }[] };
      for (const s of doc.Statement) {
        if (s.Effect !== 'Allow') continue;
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
        for (const r of roles) {
          const owner = all.find((x) => x.name === r.stack) ?? st;
          out.push({ role: roleInfo(owner, r.logicalId), actions, resources, stack: st });
        }
      }
    }
  }
  return out;
}

export const DDB_WRITE = ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem'];

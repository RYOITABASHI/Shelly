/**
 * TS mirror of IngressOrigin.kt and IngressDecision.kt (fact sheet §3 C1,
 * §4 A4; D1 decided 2026-11-25). The Kotlin side is authoritative — the
 * launcher ingress is decided natively — and __tests__/ingress-origin-parity
 * .test.ts keeps this file in step with it. RN uses it to label rules and
 * submissions (Settings) and, later, for the asynchronous approval (C6).
 *
 * Taint follows who authored the content, not who authenticated the channel:
 * every origin is tainted by default; an origin may name ops whose schema only
 * carries text a person typed, and those can be exempted when the owner's
 * grant is bound to the current caller certificates, the request carries only
 * the schema's fields, and the rate is human. MCP is never exempt.
 */

export const INGRESS_ORIGIN_MCP = 'mcp';
export const INGRESS_ORIGIN_LAUNCHER = 'launcher';

export type IngressOriginName = typeof INGRESS_ORIGIN_MCP | typeof INGRESS_ORIGIN_LAUNCHER;

export interface ExemptSchema {
  op: string;
  schemaVersion: number;
  contentFields: readonly string[];
  metadataFields: readonly string[];
}

export interface IngressOriginRow {
  origin: IngressOriginName;
  taintedByDefault: boolean;
  exemptSchemas: readonly ExemptSchema[];
}

export const INGRESS_ORIGIN_TABLE: readonly IngressOriginRow[] = [
  { origin: INGRESS_ORIGIN_MCP, taintedByDefault: true, exemptSchemas: [] },
  {
    origin: INGRESS_ORIGIN_LAUNCHER,
    taintedByDefault: true,
    exemptSchemas: [
      {
        op: 'submit_instruction',
        schemaVersion: 1,
        contentFields: ['instruction_text'],
        metadataFields: ['correlation_ref', 'submission_nonce'],
      },
    ],
  },
];

export type TaintWhy =
  | 'UNKNOWN_ORIGIN'
  | 'DEFAULT'
  | 'NO_SCHEMA'
  | 'NOT_GRANTED'
  | 'SCHEMA_VERSION'
  | 'EXTRA_FIELD'
  | 'NO_CONTENT'
  | 'RATE'
  | 'EXEMPT';

export interface TaintFacts {
  origin: string | null | undefined;
  op: string | null | undefined;
  schemaVersion: number;
  fields: readonly string[];
  exemptionBound?: boolean;
  humanRate?: boolean;
}

export interface TaintVerdict {
  tainted: boolean;
  exemptApplied: boolean;
  why: TaintWhy;
}

export function ingressOriginRow(origin: string | null | undefined): IngressOriginRow | null {
  return INGRESS_ORIGIN_TABLE.find((r) => r.origin === origin) ?? null;
}

/** IngressOrigin.taintFor. */
export function taintFor(f: TaintFacts): TaintVerdict {
  const row = ingressOriginRow(f.origin);
  if (!row) return { tainted: true, exemptApplied: false, why: 'UNKNOWN_ORIGIN' };
  if (!row.taintedByDefault) return { tainted: false, exemptApplied: false, why: 'DEFAULT' };
  const schema = row.exemptSchemas.find((s) => s.op === f.op);
  if (!schema) return { tainted: true, exemptApplied: false, why: 'NO_SCHEMA' };
  if (f.exemptionBound !== true) return { tainted: true, exemptApplied: false, why: 'NOT_GRANTED' };
  if (f.schemaVersion !== schema.schemaVersion) return { tainted: true, exemptApplied: false, why: 'SCHEMA_VERSION' };
  const all = new Set([...schema.contentFields, ...schema.metadataFields]);
  if (!f.fields.every((k) => all.has(k))) return { tainted: true, exemptApplied: false, why: 'EXTRA_FIELD' };
  if (!schema.contentFields.every((k) => f.fields.includes(k))) return { tainted: true, exemptApplied: false, why: 'NO_CONTENT' };
  if (f.humanRate !== true) return { tainted: true, exemptApplied: false, why: 'RATE' };
  return { tainted: false, exemptApplied: true, why: 'EXEMPT' };
}

/** IngressDecision.ORDER / STAGES. */
export const INGRESS_STAGE_ORDER = [
  'SETTING',
  'ARGS',
  'EPOCH',
  'TARGET',
  'STOP_ALL',
  'TAINT',
  'ACTION_CONSENT',
  'STEP7',
  'IDEMPOTENT',
  'ALWAYS_ALLOW',
  'APPROVE_ALL',
] as const;

export type IngressStage = (typeof INGRESS_STAGE_ORDER)[number];

export const INGRESS_OP_STAGES: Readonly<Record<string, readonly IngressStage[]>> = {
  run_agent: ['SETTING', 'ARGS', 'EPOCH', 'TARGET', 'STOP_ALL', 'TAINT', 'ACTION_CONSENT', 'STEP7', 'IDEMPOTENT', 'ALWAYS_ALLOW'],
  submit_instruction: ['SETTING', 'ARGS', 'STOP_ALL', 'TAINT', 'IDEMPOTENT', 'ALWAYS_ALLOW', 'APPROVE_ALL'],
  // Stream feed (C7): content always tainted, so no TAINT stage to pass and
  // no APPROVE_ALL; only a per-op always-allow rule or a tap stores it.
  put_stream_feed: ['SETTING', 'ARGS', 'EPOCH', 'STOP_ALL', 'ALWAYS_ALLOW'],
  // Phase 2 D2: the launcher submission reader. No always-allow, no approval tap.
  get_launcher_submission: ['SETTING', 'ARGS', 'EPOCH', 'STOP_ALL'],
  list_launcher_submissions: ['SETTING', 'ARGS', 'EPOCH', 'STOP_ALL'],
  mark_launcher_submission_consumed: ['SETTING', 'ARGS', 'EPOCH', 'STOP_ALL'],
};

const PRINCIPAL_ID_RE = /^[0-9a-f]{32}$/;

/** IngressDecision.Principal.parse: bare 32 hex is MCP; `<origin>:<32 hex>` for every other known origin. */
export function parseIngressPrincipal(wire: unknown): { origin: IngressOriginName; id: string } | null {
  if (typeof wire !== 'string') return null;
  const colon = wire.indexOf(':');
  if (colon < 0) return PRINCIPAL_ID_RE.test(wire) ? { origin: INGRESS_ORIGIN_MCP, id: wire } : null;
  const origin = wire.slice(0, colon);
  const id = wire.slice(colon + 1);
  if (origin === INGRESS_ORIGIN_MCP) return null;
  const row = ingressOriginRow(origin);
  if (!row || !PRINCIPAL_ID_RE.test(id)) return null;
  return { origin: row.origin, id };
}

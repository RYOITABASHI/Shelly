/**
 * C1 (fact sheet §3 C1, §4 A4; D1): one origin → taint table and one
 * decision order, Kotlin authoritative, TS mirror in step. Kotlin JVM tests
 * do not run in CI (build.gradle), so the invariants are also pinned here
 * from the Kotlin source.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  INGRESS_OP_STAGES,
  INGRESS_ORIGIN_TABLE,
  INGRESS_STAGE_ORDER,
  parseIngressPrincipal,
  taintFor,
} from '@/lib/ingress-origin';

const KT_DIR = path.join(__dirname, '..', 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator');
const kt = (name: string) => fs.readFileSync(path.join(KT_DIR, name), 'utf8');

function listBetween(src: string, start: string): string {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`missing ${start}`);
  let depth = 0;
  for (let j = src.indexOf('(', i); j < src.length; j++) {
    if (src[j] === '(') depth++;
    else if (src[j] === ')') {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  throw new Error(`unterminated ${start}`);
}

const stagesIn = (s: string) => [...s.matchAll(/Stage\.([A-Z0-9_]+)/g)].map((m) => m[1]);

describe('IngressDecision order (Kotlin) == TS mirror', () => {
  const decision = kt('IngressDecision.kt');

  it('ORDER matches', () => {
    expect(stagesIn(listBetween(decision, 'val ORDER: List<Stage> = listOf('))).toEqual([...INGRESS_STAGE_ORDER]);
  });

  it('per-op stages match, and submit_instruction skips the run_agent-only stages', () => {
    expect(stagesIn(listBetween(decision, 'OP_RUN_AGENT to setOf('))).toEqual([...INGRESS_OP_STAGES.run_agent]);
    expect(stagesIn(listBetween(decision, 'OP_SUBMIT_INSTRUCTION to setOf('))).toEqual([...INGRESS_OP_STAGES.submit_instruction]);
    expect(stagesIn(listBetween(decision, 'OP_PUT_STREAM_FEED to setOf('))).toEqual([...INGRESS_OP_STAGES.put_stream_feed]);
    expect(INGRESS_OP_STAGES.put_stream_feed).not.toContain('TAINT');
    expect(INGRESS_OP_STAGES.put_stream_feed).not.toContain('APPROVE_ALL');
    for (const s of ['EPOCH', 'TARGET', 'ACTION_CONSENT', 'STEP7']) {
      expect(INGRESS_OP_STAGES.submit_instruction).not.toContain(s);
    }
  });

  it('phase 2 D2: the launcher submission reader ops match, with no always-allow / approval / taint stage', () => {
    for (const [constName, op] of [
      ['OP_GET_LAUNCHER_SUBMISSION', 'get_launcher_submission'],
      ['OP_LIST_LAUNCHER_SUBMISSIONS', 'list_launcher_submissions'],
      ['OP_MARK_LAUNCHER_SUBMISSION_CONSUMED', 'mark_launcher_submission_consumed'],
    ] as const) {
      expect(decision).toContain(`const val ${constName} = "${op}"`);
      expect(stagesIn(listBetween(decision, `${constName} to setOf(`))).toEqual([...INGRESS_OP_STAGES[op]]);
      expect(INGRESS_OP_STAGES[op]).toEqual(['SETTING', 'ARGS', 'EPOCH', 'STOP_ALL']);
    }
    const core = kt('LauncherSubmissionCore.kt');
    const body = core.slice(core.indexOf('fun decideReader('), core.indexOf('fun readerItem('));
    expect(body).toMatch(/IngressDecision\.evaluate\(req\.tool, hooks\)/);
    expect([...body.matchAll(/IngressDecision\.Stage\.([A-Z0-9_]+) to \{/g)].map((m) => m[1])).toEqual(['SETTING', 'ARGS', 'EPOCH', 'STOP_ALL']);
  });

  it('run_agent (McpTypedOpDecision.decide) is evaluated through the shared runner with exactly its stages', () => {
    const src = kt('McpTypedOpDecision.kt');
    const body = src.slice(src.indexOf('fun decide(req: Request'), src.indexOf('// ── Result files'));
    expect(body).toMatch(/IngressDecision\.evaluate\(IngressDecision\.OP_RUN_AGENT, hooks\)/);
    const hooked = [...body.matchAll(/IngressDecision\.Stage\.([A-Z0-9_]+) to \{/g)].map((m) => m[1]);
    expect(hooked).toEqual([...INGRESS_OP_STAGES.run_agent]);
  });

});

describe('IngressOrigin table (Kotlin) == TS mirror (A4)', () => {
  const origin = kt('IngressOrigin.kt');

  it('every row and exempt schema matches', () => {
    const table = listBetween(origin, 'val TABLE: List<Row> = listOf(');
    const rows = [...table.matchAll(/Row\(\s*(MCP|LAUNCHER),\s*taintedByDefault = (true|false)/g)].map((m) => ({
      origin: m[1].toLowerCase(),
      taintedByDefault: m[2] === 'true',
    }));
    expect(rows).toEqual(INGRESS_ORIGIN_TABLE.map((r) => ({ origin: r.origin, taintedByDefault: r.taintedByDefault })));
    const schemas = [...table.matchAll(/op = "([a-z_]+)",\s*schemaVersion = (\d+),\s*contentFields = setOf\(([^)]*)\),\s*metadataFields = setOf\(([^)]*)\)/g)].map(
      (m) => ({
        op: m[1],
        schemaVersion: Number(m[2]),
        contentFields: [...m[3].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]),
        metadataFields: [...m[4].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]),
      }),
    );
    expect(schemas).toEqual(INGRESS_ORIGIN_TABLE.flatMap((r) => r.exemptSchemas.map((s) => ({ ...s }))));
  });

  it('only IngressOrigin.kt decides launcher taint: no other Kotlin file compares against the launcher origin name', () => {
    for (const f of fs.readdirSync(KT_DIR)) {
      if (!f.endsWith('.kt') || f === 'IngressOrigin.kt' || f === 'IngressDecision.kt') continue;
      const src = kt(f);
      expect({ f, hit: /==\s*"launcher"|"launcher"\s*==|IngressOrigin\.LAUNCHER\s*->/.test(src) }).toEqual({ f, hit: false });
    }
  });
});

describe('taintFor (TS) — both D1 values (exemption bound / not bound)', () => {
  const base = { origin: 'launcher', op: 'submit_instruction', schemaVersion: 1, fields: ['instruction_text'] };

  it.each([
    [false, true],
    [true, false],
  ])('exemptionBound=%s → tainted=%s', (bound, tainted) => {
    expect(taintFor({ ...base, exemptionBound: bound, humanRate: true }).tainted).toBe(tainted);
  });

  it('every other condition falls back to tainted', () => {
    const ok = { ...base, exemptionBound: true, humanRate: true };
    expect(taintFor({ ...ok, humanRate: false }).why).toBe('RATE');
    expect(taintFor({ ...ok, schemaVersion: 2 }).why).toBe('SCHEMA_VERSION');
    expect(taintFor({ ...ok, fields: ['instruction_text', 'quote'] }).why).toBe('EXTRA_FIELD');
    expect(taintFor({ ...ok, fields: ['correlation_ref'] }).why).toBe('NO_CONTENT');
    expect(taintFor({ ...ok, op: 'forward_content' }).why).toBe('NO_SCHEMA');
    expect(taintFor({ ...ok, origin: 'mcp' }).tainted).toBe(true);
    expect(taintFor({ ...ok, origin: 'nope' }).why).toBe('UNKNOWN_ORIGIN');
  });

  it('principals: bare 32 hex is MCP, launcher is prefixed, nothing else parses', () => {
    const id = '0123456789abcdef0123456789abcdef';
    expect(parseIngressPrincipal(id)).toEqual({ origin: 'mcp', id });
    expect(parseIngressPrincipal(`launcher:${id}`)).toEqual({ origin: 'launcher', id });
    for (const bad of [`mcp:${id}`, `x:${id}`, 'launcher:', id.toUpperCase(), 5, null]) expect(parseIngressPrincipal(bad)).toBeNull();
  });
});

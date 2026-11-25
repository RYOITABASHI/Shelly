/**
 * The stream feed's native half (C7), pinned as source text: the Kotlin JVM
 * tests (StreamFeedCoreTest) do not run in CI, so the invariants that matter
 * are fixed here too (fact sheet §6.2 P1–P6, §8 R2).
 */
import * as fs from 'fs';
import * as path from 'path';
import { STREAM_FEED_MAX_BYTES, STREAM_FEED_OP, STREAM_FEED_TARGET } from '@/lib/mcp-stream-feed';

const K = path.join(__dirname, '..', 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator');
const kt = (name: string) => fs.readFileSync(path.join(K, name), 'utf8');

describe('stream feed native invariants', () => {
  const core = kt('StreamFeedCore.kt');
  const store = kt('StreamFeedStore.kt');
  const consumer = kt('McpTypedOpConsumer.kt');

  it('limits and names match the TS mirror', () => {
    expect(kt('LauncherIngressLimits.kt')).toMatch(new RegExp(`MAX_FEED_BYTES = 48 \\* 1024`));
    expect(STREAM_FEED_MAX_BYTES).toBe(48 * 1024);
    expect(kt('IngressDecision.kt')).toContain(`OP_PUT_STREAM_FEED = "${STREAM_FEED_OP}"`);
    expect(core).toContain(`TARGET = "${STREAM_FEED_TARGET}"`);
    expect(kt('McpAlwaysAllowStore.kt')).toContain('IngressDecision.OP_PUT_STREAM_FEED to Regex("^stream-feed$")');
    expect(kt('McpAlwaysAllowStore.kt')).toContain('IngressDecision.OP_PUT_STREAM_FEED to IngressOrigin.MCP');
  });

  it('the op has no TAINT stage and no APPROVE_ALL (the blanket switch never covers tainted content)', () => {
    const m = kt('IngressDecision.kt').match(/OP_PUT_STREAM_FEED to setOf\(([^)]*)\)/);
    expect(m).not.toBeNull();
    const stages = m![1].split(',').map((s) => s.trim()).filter(Boolean);
    expect(stages).toEqual(['Stage.SETTING', 'Stage.ARGS', 'Stage.EPOCH', 'Stage.STOP_ALL', 'Stage.ALWAYS_ALLOW']);
  });

  it('StreamFeedCore.decide runs through the shared runner with exactly the op\'s stages', () => {
    const body = core.slice(core.indexOf('fun decide('), core.indexOf('// ── Results'));
    expect(body).toContain('IngressDecision.evaluate(OP, hooks)');
    const hooked = [...body.matchAll(/IngressDecision\.Stage\.([A-Z0-9_]+) to \{/g)].map((m) => m[1]);
    expect(hooked).toEqual(['SETTING', 'ARGS', 'EPOCH', 'STOP_ALL', 'ALWAYS_ALLOW']);
  });

  it('the consumer routes put_stream_feed to its own decision before run_agent\'s', () => {
    const route = consumer.indexOf('if (request.tool == StreamFeedCore.OP)');
    const runAgent = consumer.indexOf('McpTypedOpDecision.decide(request, steps, now)');
    expect(route).toBeGreaterThan(0);
    expect(route).toBeLessThan(runAgent);
    // A rule match is re-checked and stored under the commit lock.
    expect(consumer).toMatch(/synchronized\(commitLock\) \{\s*when \{\s*!isCurrent\(\)/);
    expect(consumer).toContain('feedSteps.matchRule(request.principal) != x.ruleId');
  });

  it('store: STOP-ALL, audit line before the write, O_EXCL temp + fsync + read-back + rename, outside $HOME', () => {
    const put = store.slice(store.indexOf('fun put('), store.indexOf('fun read('));
    const halted = put.indexOf('gate(app, deadlineMs)');
    const auditStoring = put.indexOf('"storing"');
    const replace = put.indexOf('replace(app');
    expect(halted).toBeGreaterThan(0);
    expect(auditStoring).toBeGreaterThan(halted);
    expect(replace).toBeGreaterThan(auditStoring);
    expect(put).toContain('return PutResult.Refused(StreamFeedCore.AUDIT_FAILED)');
    expect(store).toContain('noBackupFilesDir');
    expect(store).toContain('OsConstants.O_EXCL');
    expect(store).toContain('Os.fsync(fd)');
    expect(store).toContain('Os.rename(t.path, target.path)');
    expect(store).not.toMatch(/getHomeDir|"home"/);
  });

  it('review fixes: strict JSON, strict STOP-ALL, fds closed, deadline re-checked before the rename', () => {
    expect(core).toContain('if (!StrictJson.isObject(text))');
    expect(core).toContain('const val MAX_DEPTH = 64');
    // \u escapes: ASCII hex only (Character.digit would accept full-width digits).
    expect(core).not.toContain('Character.digit');
    expect(store).toMatch(/e\.errno != OsConstants\.ENOENT/);
    expect(consumer).toContain('override fun halted(): Boolean = StreamFeedStore.haltedStrict(app)');
    expect((store.match(/runCatching \{ Os\.close\(fd\) \}/g) || []).length).toBe(2);
    const rep = store.slice(store.indexOf('private fun replace('));
    expect(rep.indexOf('if (!beforeRename()) return false')).toBeLessThan(rep.indexOf('Os.rename(t.path, target.path)'));
    const mod = fs.readFileSync(path.join(K, 'TerminalEmulatorModule.kt'), 'utf8');
    const fn = mod.slice(mod.indexOf('AsyncFunction("streamFeedPut")'), mod.indexOf('// Per-agent MCP ingress taint'));
    expect(fn).toContain('StreamFeedCore.validate(args)');
    expect(fn).toContain('StreamFeedStore.put(ctx, checked, p, deadline)');
  });

  it('no feed content reaches a log or an audit line', () => {
    for (const src of [core, store, consumer]) {
      for (const line of src.split('\n').filter((l) => /Log\.[iwed]\(/.test(l))) {
        expect(line).not.toMatch(/\.text\b|feedJson|\.bytes\)|String\(.*bytes/);
      }
    }
    const writer = kt('IngressAuditWriter.kt');
    const build = writer.slice(writer.indexOf('fun buildStreamFeedLine('), writer.indexOf('fun appendStreamFeedLine('));
    expect(build).not.toMatch(/feedJson|\.text/);
    expect(build).toMatch(/put\("sha256"/);
  });

  it('get_stream_feed response keys (the contract)', () => {
    for (const k of ['"status"', '"response_version"', '"feed_json"', '"sha256"', '"bytes"', '"updated_at"', '"reason"']) {
      expect(core).toContain(k);
    }
    for (const s of ['"ok"', '"empty"', '"denied"', '"error"', '"INTERNAL_ERROR"']) expect(core).toContain(s);
  });
});

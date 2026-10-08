/**
 * Unattended PlanSpec executor: saved draft path in the run log + local-date
 * output folder naming.
 *
 * The end-to-end "draft written through the broker -> run log carries
 * savedPath" assertion lives in __tests__/plan-executor.test.ts (its broker
 * fs.write path is a known Windows-host failure, so it only runs green on
 * CI); this file covers the same contract at the function level so it is
 * host-independent.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = path.resolve(__dirname, '..');
const scriptCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
const assetCopy = path.join(root, 'modules', 'terminal-emulator', 'android', 'src', 'main', 'assets', 'shelly-plan-executor.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(scriptCopy);

const AGENT_ID = 'agent-saved-path';

function makePaths() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-saved-path-'));
  const paths = executor.runtimePaths(home, AGENT_ID);
  fs.mkdirSync(paths.logDir, { recursive: true });
  return { home, paths };
}

function makePlan(home: string) {
  return {
    agent: { id: AGENT_ID },
    tool: { type: 'local', label: 'Local LLM' },
    routeDecision: { route: 'on-device' },
    output: {
      outputDir: path.join(home, 'studio'),
      outputNameTemplate: '{date}/{slug}-{time}',
      slug: 'morning-brief',
      useGlobalOutput: true,
    },
  };
}

function readOnlyRunLog(paths: { logDir: string }): any {
  const files = fs.readdirSync(paths.logDir).filter((n) => /^\d+\.json$/.test(n));
  expect(files).toHaveLength(1);
  return JSON.parse(fs.readFileSync(path.join(paths.logDir, files[0]), 'utf8'));
}

describe('writeRunLog carries the saved draft path (parity with the .sh SAVED_PATH_FIELDS)', () => {
  it('records savedPath / savedPathMirror once writeDraftOutputs has set them', () => {
    const { home, paths } = makePaths();
    paths.savedOutput = {
      savedPath: path.join(home, 'agent-output', '2026-10-08', '2026-10-08_morning-brief.md'),
      savedPathMirror: path.join(home, 'vault', '2026-10-08_morning-brief.md'),
    };
    executor.writeRunLog(paths, makePlan(home), 'success', 'done', 10, '', [
      { index: 0, instruction: 'collect', status: 'success', durationMs: 1, outputPreview: 'a' },
      { index: 1, instruction: 'write', status: 'success', durationMs: 1, outputPreview: 'b' },
    ]);
    const log = readOnlyRunLog(paths);
    expect(log.savedPath).toBe(paths.savedOutput.savedPath);
    expect(log.savedPathMirror).toBe(paths.savedOutput.savedPathMirror);
    expect(log.steps).toHaveLength(2);
  });

  it('omits both keys when nothing was saved (run-log bytes unchanged for non-draft runs)', () => {
    const { home, paths } = makePaths();
    executor.writeRunLog(paths, makePlan(home), 'success', 'done', 10, '');
    const log = readOnlyRunLog(paths);
    expect('savedPath' in log).toBe(false);
    expect('savedPathMirror' in log).toBe(false);
  });

  it('uses the same field names the attended .sh run log writes', () => {
    const agentExecutorSrc = fs.readFileSync(path.join(root, 'lib', 'agent-executor.ts'), 'utf8');
    expect(agentExecutorSrc).toContain('\\\\"savedPath\\\\":');
    expect(agentExecutorSrc).toContain('\\\\"savedPathMirror\\\\":');
  });

  it('writeDraftOutputs records the destination only after every broker write succeeded', () => {
    const src = fs.readFileSync(scriptCopy, 'utf8');
    const body = src.slice(src.indexOf('async function writeDraftOutputs'), src.indexOf('function registerSourceUrls'));
    const writeIdx = body.indexOf('await brokerFsWrite(');
    const recordIdx = body.indexOf('paths.savedOutput = {');
    expect(writeIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeGreaterThan(writeIdx);
    // Inside the try, so a swallowed bestEffort failure never advertises a file.
    expect(body.indexOf('} catch (e) {')).toBeGreaterThan(recordIdx);
  });

  it('the APK asset mirror is byte-identical to scripts/', () => {
    expect(fs.readFileSync(assetCopy, 'utf8')).toBe(fs.readFileSync(scriptCopy, 'utf8'));
  });
});

describe('draft output folder uses the LOCAL date (matches the .sh `date +%Y-%m-%d`)', () => {
  it('localDateTimeStamps formats local calendar fields, not UTC', () => {
    // Local 2026-10-08 00:30:05 — in any timezone east of UTC this instant is
    // still 2026-10-07 in UTC, which is the near-midnight bug being fixed.
    const now = new Date(2026, 9, 8, 0, 30, 5);
    expect(executor.localDateTimeStamps(now)).toEqual({ date: '2026-10-08', time: '003005' });
  });

  it('global-output destination is <base>/<local date>/<local date>_<slug>.md', () => {
    const { home, paths } = makePaths();
    const now = new Date(2026, 0, 2, 23, 59, 59);
    const { dest, useGlobalOutput } = executor.resolveDraftDestination(paths, makePlan(home), {}, now);
    expect(useGlobalOutput).toBe(true);
    expect(dest).toBe(path.join(home, 'agent-output', '2026-01-02', '2026-01-02_morning-brief.md'));
  });

  it('content-studio template expands {date}/{time} with local values too', () => {
    const { home, paths } = makePaths();
    const plan = makePlan(home);
    plan.output.useGlobalOutput = false;
    const now = new Date(2026, 6, 4, 7, 5, 9);
    const { dest } = executor.resolveDraftDestination(paths, plan, {}, now);
    expect(dest).toBe(path.join(home, 'studio', '2026-07-04', 'morning-brief-070509.md'));
  });

  it('no toISOString-based date remains in resolveDraftDestination', () => {
    const src = fs.readFileSync(scriptCopy, 'utf8');
    const body = src.slice(src.indexOf('function resolveDraftDestination'), src.indexOf('function obsidianTargetFor'));
    expect(body).not.toContain('toISOString');
  });
});

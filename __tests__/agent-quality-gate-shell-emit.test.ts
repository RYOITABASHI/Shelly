/**
 * Regression test for a real bug found by an adversarial review 2026-07-15:
 * lib/agent-executor.ts's entire generated shell script is ONE outer TS
 * template literal, so a regex source written as `\s`/`\b` inside a NEW
 * embedded `shelly_node -e '...'` block gets consumed by the OUTER template
 * literal's own escape-sequence parsing before the shell/node ever sees it —
 * `\s` silently drops its backslash (Annex B legacy behavior) and `\b`
 * becomes a literal backspace control character. A hand-copied "verification"
 * of the intended source (not the actual compiled output) missed this
 * entirely. This test extracts the REAL emitted script text via
 * generateRunScript() and executes the REAL embedded JS with a local node
 * child process, so it fails the same way production would if the escaping
 * regresses again.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { Agent, ToolChoice } from '@/store/types';

function agent(tool: ToolChoice): Agent {
  return {
    id: 'a',
    name: 'A',
    description: '',
    prompt: 'summarize this',
    schedule: null,
    tool,
    outputPath: '~/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
  };
}

function extractEmbeddedJs(script: string): string {
  // Anchor on the function name FIRST — this file has multiple unrelated
  // `shelly_node -e '...'` call sites (e.g. json_escape_text), so a bare
  // search for that generic marker can silently grab the wrong one.
  const fnMarker = 'is_low_quality_completion() {';
  const fnStart = script.indexOf(fnMarker);
  if (fnStart === -1) throw new Error('is_low_quality_completion function not found in generated script');
  const marker = "shelly_node -e '";
  const start = script.indexOf(marker, fnStart);
  if (start === -1) throw new Error('is_low_quality_completion node block not found in generated script');
  const bodyStart = start + marker.length;
  const end = script.indexOf("\n' 2>/dev/null", bodyStart);
  if (end === -1) throw new Error('closing marker for the embedded JS block not found');
  return script.slice(bodyStart, end);
}

function extractCaseBlock(script: string, caseLabel: string): string {
  // Anchor on dispatch_agent_action() first — "notify)" (and similar labels)
  // can otherwise match unrelated text elsewhere in this giant generated script.
  const fnMarker = 'dispatch_agent_action() {';
  const fnStart = script.indexOf(fnMarker);
  if (fnStart === -1) throw new Error('dispatch_agent_action function not found in generated script');
  const marker = `\n    ${caseLabel})`;
  const start = script.indexOf(marker, fnStart);
  if (start === -1) throw new Error(`case block "${caseLabel})" not found in dispatch_agent_action`);
  const bodyStart = start + marker.length;
  const end = script.indexOf('\n      ;;', bodyStart);
  if (end === -1) throw new Error(`closing ";;" for case block "${caseLabel})" not found`);
  return script.slice(bodyStart, end);
}

function extractFullFunction(script: string): string {
  const fnMarker = 'is_low_quality_completion() {';
  const fnStart = script.indexOf(fnMarker);
  if (fnStart === -1) throw new Error('is_low_quality_completion function not found in generated script');
  const fnEnd = script.indexOf('\n}', fnStart);
  if (fnEnd === -1) throw new Error('closing brace for is_low_quality_completion not found');
  return script.slice(fnStart, fnEnd + 2);
}

/**
 * Runs the REAL, FULL bash function (not just its embedded JS) via a real
 * bash process — this is what exercises the shell-level empty/whitespace
 * trim check, which runs BEFORE node is ever invoked. node_usable/shelly_node
 * are stubbed to proxy to the real local `node` binary (the production
 * versions resolve an Android-bundled binary via shelly_run_app_binary,
 * unavailable on this dev machine) so the echo/refusal branch still executes
 * for real too, not just the early-return empty-check branch.
 */
function runFullFunctionCheck(fnText: string, text: string): number {
  const wrapperPath = path.join(os.tmpdir(), `shelly-quality-gate-wrapper-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
  const nodeBin = process.execPath.replace(/\\/g, '/');
  const script = `node_usable() { return 0; }
shelly_node() { "${nodeBin}" "$@"; }
${fnText}
is_low_quality_completion "$1"
`;
  fs.writeFileSync(wrapperPath, script, 'utf8');
  try {
    execFileSync('bash', [wrapperPath, text], { stdio: 'pipe' });
    return 0;
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (typeof status === 'number') return status;
    throw err;
  } finally {
    fs.unlinkSync(wrapperPath);
  }
}

function runEmbeddedCheck(js: string, text: string): number {
  const tmpFile = path.join(os.tmpdir(), `shelly-quality-gate-check-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(tmpFile, js, 'utf8');
  try {
    execFileSync(process.execPath, [tmpFile], {
      env: { ...process.env, SHELLY_QUALITY_CHECK_TEXT: text },
      stdio: 'pipe',
    });
    return 0;
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (typeof status === 'number') return status;
    throw err;
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

describe('is_low_quality_completion — real emitted-script escaping (regression)', () => {
  const script = generateRunScript(agent({ type: 'local' }));
  const embeddedJs = extractEmbeddedJs(script);

  it('the emitted regex source has real backslash escapes, not dropped/backspace chars', () => {
    // A hand-copied "looks right" check missed this — assert directly on the
    // ACTUAL extracted text so a re-regression (outer-template escaping
    // eaten again) fails here instead of silently reaching production.
    expect(embeddedJs).toContain('\\s*Results from previous steps');
    expect(embeddedJs).toContain('\\s*This step\\b');
    expect(embeddedJs).toContain('\\bas an ai\\b');
    // Must NOT contain a literal backspace control character () where
    // \b was intended — the exact failure mode the reviewer caught.
    expect(embeddedJs.includes('')).toBe(false);
  });

  it('detects the real on-device echoed-prompt-plus-refusal text', () => {
    const echoed =
      '# Results from previous steps ## Step 1 パープレで検索して ## Step 2 保存する。 --- ' +
      '# This step X用に再要約して投稿して --- Note: As an AI, I cannot generate a literal X post with a';
    expect(runEmbeddedCheck(embeddedJs, echoed)).toBe(0);
  });

  it('detects a bare EN refusal with no prompt echo', () => {
    expect(runEmbeddedCheck(embeddedJs, 'As an AI, I cannot generate a literal social media post.')).toBe(0);
  });

  it('detects a bare JA refusal', () => {
    expect(runEmbeddedCheck(embeddedJs, '私はAIなので、実際の投稿はできません。')).toBe(0);
  });

  it('detects a genuine "I\'m unable to..." refusal', () => {
    expect(runEmbeddedCheck(embeddedJs, "I'm unable to publish this to X directly.")).toBe(0);
  });

  it('does not flag real content', () => {
    expect(runEmbeddedCheck(embeddedJs, 'STEAM教育×AIの最新動向まとめ: 論文3件、ニュース2件を要約しました。')).toBe(1);
    expect(runEmbeddedCheck(embeddedJs, 'This step forward for AI in education looks promising.')).toBe(1);
    // Regression: a hand-typed `.` wildcard in place of the escaped apostrophe
    // ('\bi.m ...' instead of '\bi\x27m ...') would wrongly match "IBM" here —
    // a real false positive an earlier draft of this fix actually shipped.
    expect(runEmbeddedCheck(embeddedJs, 'IBM unable to deliver chips after the outage.')).toBe(1);
  });

  it('detects the real on-device "honest failure to retrieve data" repro (2026-07-23 battery-notify finding)', () => {
    // Verbatim (trimmed) shape of what Codex CLI reported for the "notify me
    // of battery level" agent — neither a prompt echo nor refusal boilerplate,
    // so it previously matched neither pattern set and reached the confirm
    // card / run log as a "success".
    const honestFailure = 'この実行環境では端末のバッテリー情報へアクセスできず、残量を取得できませんでした。';
    expect(runEmbeddedCheck(embeddedJs, honestFailure)).toBe(0);
  });

  it('detects short EN "could not retrieve/access" completions', () => {
    expect(runEmbeddedCheck(embeddedJs, 'I could not retrieve the battery level in this execution environment.')).toBe(0);
    expect(runEmbeddedCheck(embeddedJs, 'Sorry, I was unable to access the battery information.')).toBe(0);
    expect(runEmbeddedCheck(embeddedJs, "I couldn't retrieve the requested value.")).toBe(0);
  });

  it('does NOT flag a long, otherwise-substantive response that merely mentions a similar phrase in passing (explicit negative)', () => {
    const longGenuineSummary =
      'STEAM教育×AIの最新動向まとめ: 論文3件、ニュース2件を要約しました。' +
      '1件目は初等教育でのAI活用事例、2件目は高校でのプログラミング教育カリキュラム改訂、' +
      '3件目は大学の産学連携プロジェクトについてです。ニュースでは政府の教育予算方針と、' +
      '地方自治体のICT導入状況を取り上げました。なお、この件については詳細情報が取得できません' +
      'でしたので、続報が出次第追跡します。全体として教育現場でのAI活用は着実に進んでいます。';
    expect(runEmbeddedCheck(embeddedJs, longGenuineSummary)).toBe(1);

    const longEnglishSummary =
      'Q3 revenue grew 12% year over year, driven by strong enterprise adoption. ' +
      'The APAC region led growth at 18%, while EMEA grew 9%. Customer churn ' +
      'improved to 4.2% from 5.1% last quarter. One regional breakdown for ' +
      'Southeast Asia specifically was unable to access at this time, but the ' +
      'overall trend across all other regions remains strongly positive, with ' +
      'gross margin holding steady at 71% for the third consecutive quarter.';
    expect(runEmbeddedCheck(embeddedJs, longEnglishSummary)).toBe(1);
  });

  it('the emitted regex source for the meta-commentary check has real backslash escapes', () => {
    expect(embeddedJs).toContain('を(?:送信します|送信しました|お送りします|お送りしました|完了します|完了しました|実行します|実行しました)');
    expect(embeddedJs).toContain('\\bnotification (?:has been |is |was )?(?:sent|completed|delivered)\\b');
    expect(embeddedJs).toContain('\\btask (?:has been |is |was )?completed\\b');
  });

  it('detects the real on-device "meta-commentary about the delivery action" repro (2026-07-25, bug #158 follow-up)', () => {
    // Verbatim (trimmed) shape of what Qwen3.5-2B reported for the same
    // "notify me about the news" task after the needsWeb routing fix landed —
    // a direct A/B comparison against 0.8B on the identical repro. Announces
    // the delivery action instead of delivering content or admitting failure.
    expect(runEmbeddedCheck(embeddedJs, 'ニュース通知を送信します。')).toBe(0);
    expect(runEmbeddedCheck(embeddedJs, 'ニュース通知を完了しました。')).toBe(0);
  });

  it('detects short EN "notification sent/completed" meta-commentary', () => {
    expect(runEmbeddedCheck(embeddedJs, 'The notification has been sent.')).toBe(0);
    expect(runEmbeddedCheck(embeddedJs, 'Notification completed.')).toBe(0);
    expect(runEmbeddedCheck(embeddedJs, 'Sending the notification now.')).toBe(0);
    expect(runEmbeddedCheck(embeddedJs, 'Task completed.')).toBe(0);
  });

  it('does NOT flag genuine notify content that happens to use similar words (explicit negative)', () => {
    expect(runEmbeddedCheck(embeddedJs, '明日の会議室変更のお知らせです。新しい会議室はB201です。')).toBe(1);
    expect(runEmbeddedCheck(embeddedJs, '重要なお知らせ：システムメンテナンスは22時から実施されます。')).toBe(1);
    expect(runEmbeddedCheck(embeddedJs, 'Your package delivery notification: arriving between 2-4pm today.')).toBe(1);
  });

  it('the emitted regex source for the fabricated-execution check has real backslash escapes', () => {
    expect(embeddedJs).toContain('\\b(?:command|script)\\s+(?:was\\s+)?executed\\b[\\s\\S]{0,100}\\bstatus:\\s*success\\b');
    expect(embeddedJs).toContain('(?:コマンド|スクリプト)を実行(?:しました|完了しました)');
  });

  it('detects the real on-device fabricated command-execution report via the actual emitted script (2026-07-27, bug #162)', () => {
    // Verbatim (trimmed) shape of what the "Shell Script" agent's Local LLM
    // backend reported for a draft-typed "write X via shell command" task —
    // a fully-detailed but entirely fabricated success transcript. Confirmed
    // on-device that draft has zero real execution capability; the model
    // free-text-narrates this instead of refusing or admitting it can't run
    // commands.
    const shellScriptRepro =
      'Command executed: \'echo "test" > /sdcard/probe.txt\' Status: Success File created at \'/sdcard/probe.txt\' Content: test';
    expect(runEmbeddedCheck(embeddedJs, shellScriptRepro)).toBe(0);
  });

  it('detects the real on-device fabricated shell-prompt transcript via the actual emitted script (2026-07-27, unattended repro)', () => {
    // Reproduced a SECOND time on a genuinely unattended scheduled fire — the
    // saved draft .md content was a fabricated shell-prompt line instead of
    // first-person prose.
    expect(runEmbeddedCheck(embeddedJs, "root@docker:~# printf 'test' > /sdcard/probe2.txt")).toBe(0);
  });

  it('detects the JA fabricated-execution phrasing via the actual emitted script', () => {
    expect(runEmbeddedCheck(embeddedJs, 'コマンドを実行しました。ステータス: 成功')).toBe(0);
    expect(runEmbeddedCheck(embeddedJs, 'スクリプトを実行完了しました。成功しました。')).toBe(0);
  });

  it('does NOT flag genuine instructional draft content that merely shows a command (explicit negative)', () => {
    expect(
      runEmbeddedCheck(
        embeddedJs,
        'ファイルにテキストを書き込むには `echo \'test\' > file.txt` のようなコマンドを使います。' +
          'リダイレクト演算子 > は既存の内容を上書きする点に注意してください。',
      ),
    ).toBe(1);
    expect(
      runEmbeddedCheck(
        embeddedJs,
        'To write text to a file, use a command like `echo \'test\' > file.txt`. ' +
          'Note that the > redirect operator overwrites any existing content.',
      ),
    ).toBe(1);
  });

  it('detects the real on-device bare-command-line repro via the actual emitted script (2026-07-28, third fabrication shape)', () => {
    // Re-tested the v34 fix on the very next build: no "Status: Success"
    // wrapper, no fake prompt — just the raw command as the entire
    // completion, still notified as success.
    expect(runEmbeddedCheck(embeddedJs, 'echo "Test executed" > /sdcard/probe3.txt')).toBe(0);
  });

  it('detects other bare shell-command-line shapes via the actual emitted script', () => {
    expect(runEmbeddedCheck(embeddedJs, "printf 'test' > /sdcard/probe.txt")).toBe(0);
    expect(runEmbeddedCheck(embeddedJs, 'cat /etc/hosts | grep localhost')).toBe(0);
  });

  it('does NOT flag a bare non-command single line via the actual emitted script', () => {
    expect(runEmbeddedCheck(embeddedJs, 'こんにちは、今日は晴れです。')).toBe(1);
    expect(runEmbeddedCheck(embeddedJs, 'The weather today is sunny.')).toBe(1);
  });

  it('detects the real on-device bare-redirect repro via the actual emitted script (2026-07-28, fourth fabrication shape)', () => {
    // Re-tested v36 on the SAME build within the hour: no command verb at
    // all, just a redirect and a path, still notified as success.
    expect(runEmbeddedCheck(embeddedJs, '> /sdcard/probe4.txt')).toBe(0);
  });

  it('does NOT flag genuine prose that merely contains a > or | character mid-sentence via the actual emitted script', () => {
    expect(runEmbeddedCheck(embeddedJs, '売上は前年比で50%以上伸びました。')).toBe(1);
    expect(runEmbeddedCheck(embeddedJs, 'Revenue grew more than 50% year over year.')).toBe(1);
  });

  it('detects the real on-device fenced-shell-transcript repro via the actual emitted script (2026-07-28, fifth fabrication shape)', () => {
    // Found re-testing task#17/#18/bug#165 on the very next build: a whole
    // markdown code fence with no surrounding prose, still notified as a
    // plain success — the target file was never actually created.
    expect(runEmbeddedCheck(embeddedJs, "```text\ncd /sdcard\necho 'test' > probe_verify.txt\ncat probe_verify.txt\n```")).toBe(0);
  });

  it('does NOT flag a legitimate fenced code answer in another language via the actual emitted script', () => {
    expect(runEmbeddedCheck(embeddedJs, '```python\nfor i in range(1, 101):\n    print(i)\n```')).toBe(1);
  });

  it('does NOT flag a fenced code example with surrounding prose via the actual emitted script', () => {
    expect(
      runEmbeddedCheck(
        embeddedJs,
        '以下のコマンドでファイルを作成できます。\n```text\necho \'test\' > file.txt\n```\n上書きされる点にご注意ください。',
      ),
    ).toBe(1);
  });

  it('detects the real on-device execution-narrative repro via the actual emitted script (2026-07-28, SIXTH fabrication shape)', () => {
    // Abridged from the verbatim versionCode-1995 response (bug #162 v43
    // verification pass): prose + ```bash fences + "コマンドを実行します"
    // self-claims, no actual execution — the target file was never created.
    expect(
      runEmbeddedCheck(
        embeddedJs,
        'この依頼を履行するため、以下の手順で Shell コマンドを実行します。\n\n### 手順：シェルコマンドを実行\n\n' +
          '```bash\necho "test" > /sdcard/probe_verify2.txt\ncat /sdcard/probe_verify2.txt\n```\n\n### 実行結果の確認\n\n上記の命令を再度実行します。',
      ),
    ).toBe(0);
  });

  it('does NOT flag an imperative how-to draft (実行してください) with a shell fence via the actual emitted script', () => {
    expect(
      runEmbeddedCheck(
        embeddedJs,
        '以下のコマンドを実行してください。\n```bash\necho \'test\' > file.txt\n```\n実行すると file.txt が作成されます。',
      ),
    ).toBe(1);
  });
});

describe('is_low_quality_completion — empty/whitespace-only completion (real bash execution, regression)', () => {
  // 2026-07-15: the codex-driver path's clean_result_preview() strips every
  // line the driver ever prints (all 8 of its telemetry prefixes), so a
  // Codex-routed step that completes successfully can still yield a fully
  // empty $preview — which, before this fix, silently reached the confirm
  // card as a blank content box instead of failing loud (empty text matched
  // neither the echo nor the refusal patterns). This exercises the REAL
  // shell trim logic via a real bash process, not the embedded JS alone —
  // the empty check runs in plain shell, before node is ever invoked.
  const script = generateRunScript(agent({ type: 'local' }));
  const fnText = extractFullFunction(script);

  it('flags a fully empty completion', () => {
    expect(runFullFunctionCheck(fnText, '')).toBe(0);
  });

  it('flags a whitespace-only completion (spaces, tabs, newlines)', () => {
    expect(runFullFunctionCheck(fnText, '   \n\t  \n')).toBe(0);
  });

  it('still flags echo/refusal content through the full function (not just the embedded JS)', () => {
    expect(runFullFunctionCheck(fnText, 'As an AI, I cannot generate a literal social media post.')).toBe(0);
  });

  it('flags the honest "could not retrieve data" completion through the full function', () => {
    expect(runFullFunctionCheck(fnText, 'この実行環境では端末のバッテリー情報へアクセスできず、残量を取得できませんでした。')).toBe(0);
  });

  it('does not flag real content with surrounding whitespace', () => {
    expect(runFullFunctionCheck(fnText, '  STEAM教育×AIの最新動向まとめ。  ')).toBe(1);
  });
});

describe('dispatch_agent_action — quality gate wired into draft/notify (real emitted case blocks)', () => {
  const script = generateRunScript(agent({ type: 'local' }));

  it('gates the draft case ("|draft) before save_draft_result, regardless of the approval branch', () => {
    const draftCase = extractCaseBlock(script, '""|draft');
    const gateIdx = draftCase.indexOf('is_low_quality_completion "$preview"');
    const approvalIdx = draftCase.indexOf('request_and_wait_approval "draft"');
    const saveIdx = draftCase.indexOf('save_draft_result "$result_file"');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(approvalIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeGreaterThan(-1);
    // The gate must run before BOTH the optional approval tap and the actual
    // file write, so an autonomous run (which skips the approval branch
    // entirely) still can't reach save_draft_result with bad content.
    expect(gateIdx).toBeLessThan(approvalIdx);
    expect(gateIdx).toBeLessThan(saveIdx);
    expect(draftCase).toContain('ACTION_DISPATCH_STATUS="error"');
    expect(draftCase).toContain('Draft content looks like a prompt echo or AI refusal');
  });

  it('gates the notify case before request_and_wait_approval / write_native_notification_request "success"', () => {
    const notifyCase = extractCaseBlock(script, 'notify');
    const gateIdx = notifyCase.indexOf('is_low_quality_completion "$preview"');
    const approvalIdx = notifyCase.indexOf('request_and_wait_approval "notify"');
    const successNotifyIdx = notifyCase.indexOf('write_native_notification_request "success" "$preview"');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(approvalIdx).toBeGreaterThan(-1);
    expect(successNotifyIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(approvalIdx);
    expect(gateIdx).toBeLessThan(successNotifyIdx);
    expect(notifyCase).toContain('ACTION_DISPATCH_STATUS="error"');
    expect(notifyCase).toContain('Notify content looks like a prompt echo or AI refusal');
  });

  it('the draft/notify gate calls the SAME is_low_quality_completion function already exercised above', () => {
    // Not a hand-copied duplicate check: the function under is_low_quality_completion()
    // is the single source of truth exercised by the earlier describe block's real
    // node child-process runs; this only asserts the draft/notify cases call it.
    const draftCase = extractCaseBlock(script, '""|draft');
    const notifyCase = extractCaseBlock(script, 'notify');
    expect(script).toContain('is_low_quality_completion() {');
    expect(draftCase).toMatch(/if is_low_quality_completion "\$preview"; then/);
    expect(notifyCase).toMatch(/if is_low_quality_completion "\$preview"; then/);
  });
});

/**
 * Regression test for a real on-device finding 2026-07-27: a needsWeb task
 * ("ニュースを通知して") routed all the way to Codex even though Gemini's grounded
 * attempt already produced real, useful news content — the needsWeb no-URL
 * guard (right after generateToolCommand's call in generateRunScript) could
 * not tell "backend wrote a design essay" apart from "Gemini performed a real
 * Google Search grounded call whose citations live in a separate
 * groundingMetadata JSON field, never inline text". This extracts the REAL
 * emitted guard snippet and executes it with real bash against fixture files,
 * so it fails the same way production would if the escaping or the new
 * groundingChunks skip-condition regresses.
 */
function extractNoUrlGuard(script: string): string {
  const startMarker = 'if [ ! -f "$BACKEND_ERROR_FILE" ] && ! grep -qE \'https?://\' "$RESULT_CONTENT_FILE"';
  const start = script.indexOf(startMarker);
  if (start === -1) throw new Error('needsWeb no-URL guard not found in generated script');
  const endMarker = '\nrm -f "$RESULT_FILE.response.json.diag"';
  const end = script.indexOf(endMarker, start);
  if (end === -1) throw new Error('closing cleanup line for the no-URL guard not found');
  return script.slice(start, end + endMarker.length);
}

function runNoUrlGuard(opts: { resultContent: string; diagContent?: string }): {
  backendErrorTouched: boolean;
  resultFileContent: string;
  diagFileRemoved: boolean;
} {
  const script = generateRunScript({ ...agent({ type: 'perplexity' }), prompt: '最新ニュースを集めて' });
  const guard = extractNoUrlGuard(script);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-no-url-guard-'));
  const RESULT_FILE = path.join(dir, 'result');
  const RESULT_CONTENT_FILE = `${RESULT_FILE}.answer`;
  const BACKEND_ERROR_FILE = path.join(dir, 'backend-error');
  const DIAG_FILE = `${RESULT_FILE}.response.json.diag`;
  fs.writeFileSync(RESULT_CONTENT_FILE, opts.resultContent, 'utf8');
  fs.writeFileSync(RESULT_FILE, '', 'utf8');
  if (opts.diagContent !== undefined) {
    fs.writeFileSync(DIAG_FILE, opts.diagContent, 'utf8');
  }
  const wrapperPath = path.join(dir, 'wrapper.sh');
  const wrapper = `RESULT_FILE="${RESULT_FILE}"
RESULT_CONTENT_FILE="${RESULT_CONTENT_FILE}"
BACKEND_ERROR_FILE="${BACKEND_ERROR_FILE}"
${guard}
`;
  fs.writeFileSync(wrapperPath, wrapper, 'utf8');
  try {
    execFileSync('bash', [wrapperPath], { stdio: 'pipe' });
    return {
      backendErrorTouched: fs.existsSync(BACKEND_ERROR_FILE),
      resultFileContent: fs.readFileSync(RESULT_FILE, 'utf8'),
      diagFileRemoved: !fs.existsSync(DIAG_FILE),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('needsWeb no-URL guard — real bash execution (Gemini grounding skip, 2026-07-27 regression)', () => {
  it('marks a plain no-URL, non-Gemini result as a soft failure (unchanged pre-v31 behavior)', () => {
    const r = runNoUrlGuard({ resultContent: 'no links here' });
    expect(r.backendErrorTouched).toBe(true);
    expect(r.resultFileContent).toContain('Collection produced no primary-source links');
    expect(r.diagFileRemoved).toBe(true);
  });

  it('does NOT mark a genuinely grounded Gemini result (groundingChunks>0) as a failure, even with no inline URL', () => {
    const r = runNoUrlGuard({
      resultContent: 'ニュースの要約はこちらです。特にURLの言及はありません。',
      diagContent: 'gemini finishReason=STOP groundingChunks=5 inlineUrl=false\n',
    });
    expect(r.backendErrorTouched).toBe(false);
    expect(r.resultFileContent).toBe('');
    expect(r.diagFileRemoved).toBe(true);
  });

  it('still marks as a failure when the diag file exists but groundingChunks=0 (e.g. a genuine MAX_TOKENS truncation), and surfaces the diagnostic', () => {
    const r = runNoUrlGuard({
      resultContent: '',
      diagContent: 'gemini finishReason=MAX_TOKENS groundingChunks=0 inlineUrl=false\n',
    });
    expect(r.backendErrorTouched).toBe(true);
    expect(r.resultFileContent).toContain('Collection produced no primary-source links');
    expect(r.resultFileContent).toContain('Diagnostic: gemini finishReason=MAX_TOKENS groundingChunks=0 inlineUrl=false');
    expect(r.diagFileRemoved).toBe(true);
  });

  it('a result WITH an inline URL never even reaches the guard body (unchanged) — no diag file needed', () => {
    const r = runNoUrlGuard({ resultContent: 'See https://example.com for details' });
    expect(r.backendErrorTouched).toBe(false);
    expect(r.resultFileContent).toBe('');
  });

  it('a non-Gemini backend (no diag file at all) falls through to the unchanged pre-v31 soft-failure path', () => {
    const r = runNoUrlGuard({ resultContent: 'a plain essay with no sources' });
    expect(r.backendErrorTouched).toBe(true);
    expect(r.resultFileContent).not.toContain('Diagnostic:');
  });
});

function extractShellFunctionRange(script: string, startMarker: string, endMarker: string): string {
  const start = script.indexOf(startMarker);
  if (start === -1) throw new Error(`generated shell start marker not found: ${startMarker}`);
  const end = script.indexOf(endMarker, start);
  if (end === -1) throw new Error(`generated shell end marker not found: ${endMarker}`);
  return script.slice(start, end);
}

function extractGeminiCommand(script: string): string {
  const anchor = '# The 2.0-flash free tier is limit:0';
  const anchorIndex = script.indexOf(anchor);
  if (anchorIndex === -1) throw new Error('Gemini command anchor not found');
  const start = script.lastIndexOf('PROMPT_FILE=', anchorIndex);
  const end = script.indexOf('\nrm -f "$PROMPT_FILE" "$REQUEST_FILE"', anchorIndex);
  if (start === -1 || end === -1) throw new Error('Gemini command bounds not found');
  return script.slice(start, end + '\nrm -f "$PROMPT_FILE" "$REQUEST_FILE"'.length);
}

function waitForFile(file: string, timeoutMs = 5000): void {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

describe('Gemini HTTP failure diagnostics — real emitted bash against synthetic HTTP response', () => {
  it('detects a 401, preserves its body/status, and sends the sourced key plus google_search tool', () => {
    const emitted = generateRunScript({ ...agent({ type: 'gemini-api' }), prompt: '最新ニュースを集めて' });
    const httpFunctions = extractShellFunctionRange(emitted, 'http_post_json() {', '\nhttp_get_ok() {');
    const geminiCommand = extractGeminiCommand(emitted);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-gemini-http-diag-'));
    const portFile = path.join(dir, 'port');
    const captureFile = path.join(dir, 'capture.json');
    const serverFile = path.join(dir, 'server.js');
    fs.writeFileSync(serverFile, `
const fs = require('fs');
const http = require('http');
const server = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    fs.writeFileSync(process.argv[3], JSON.stringify({ key: req.headers['x-goog-api-key'], body }));
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 401, message: 'API key not valid. Please pass a valid API key.', status: 'UNAUTHENTICATED' } }));
    server.close();
  });
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[2], String(server.address().port)));
`, 'utf8');
    const server = spawn(process.execPath, [serverFile, portFile, captureFile], { stdio: 'pipe' });
    try {
      waitForFile(portFile);
      const port = fs.readFileSync(portFile, 'utf8');
      const resultFile = path.join(dir, 'result');
      const envFile = path.join(dir, 'agents.env');
      fs.writeFileSync(envFile, "GEMINI_API_KEY='synthetic-key.with_punctuation-123'\n", 'utf8');
      const nodeBin = process.execPath.replace(/\\/g, '/');
      const wrapper = `set -e
HOME="${dir.replace(/\\/g, '/')}"
mkdir -p "$HOME/.shelly/tmp"
AGENT_ID=a
RESULT_FILE="${resultFile.replace(/\\/g, '/')}"
RESULT_CONTENT_FILE="$RESULT_FILE"
BACKEND_ERROR_FILE="$HOME/backend-error"
TRANSIENT_ERROR_FILE="$HOME/transient-error"
TIMEOUT=5
SOURCE_CONTEXT=""
CURRENT_DATETIME_CONTEXT=""
DEVICE_STATUS_CONTEXT=""
SHELLY_CAP_BROKER=0
node_usable() { return 0; }
shelly_node() { "${nodeBin}" "$@"; }
json_string_file() { "${nodeBin}" -e 'const fs=require("fs");process.stdout.write(JSON.stringify(fs.readFileSync(process.argv[1],"utf8")))' "$1"; }
extract_ai_content() { return 99; }
source "${envFile.replace(/\\/g, '/')}"
${httpFunctions}
${geminiCommand.replaceAll('https://generativelanguage.googleapis.com', `http://127.0.0.1:${port}`)}
`;
      const wrapperFile = path.join(dir, 'wrapper.sh');
      fs.writeFileSync(wrapperFile, wrapper, 'utf8');
      execFileSync('bash', [wrapperFile], { stdio: 'pipe' });

      const result = fs.readFileSync(resultFile, 'utf8');
      const diag = fs.readFileSync(`${resultFile}.response.json.diag`, 'utf8');
      if (!fs.existsSync(captureFile)) {
        throw new Error(`synthetic server received no request; result=${result}; diag=${diag}`);
      }
      const capture = JSON.parse(fs.readFileSync(captureFile, 'utf8')) as { key: string; body: string };
      expect(fs.existsSync(path.join(dir, 'backend-error'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'transient-error'))).toBe(false);
      expect(diag).toContain('gemini httpStatus=401 exit=22');
      expect(diag).toContain('API key not valid');
      expect(result).toContain('gemini httpStatus=401 exit=22');
      expect(capture.key).toBe('synthetic-key.with_punctuation-123');
      expect(JSON.parse(capture.body).tools).toEqual([{ google_search: {} }]);
    } finally {
      server.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

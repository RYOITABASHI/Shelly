import {
  resolveEscalationLadder,
  attemptFailed,
  isDeterministicDispatchFailure,
  isLocalFallbackDigest,
  isLowQualityCompletion,
  LadderEnv,
} from '@/lib/agent-escalation-ladder';
import { Agent, ToolChoice } from '@/store/types';

const KEYED: LadderEnv = { hasCerebrasKey: true, hasGroqKey: true };
const NO_KEYS: LadderEnv = { hasCerebrasKey: false, hasGroqKey: false };

const mk = (over: Partial<Agent> = {}): Agent => ({
  id: 'a',
  name: 'A',
  description: '',
  prompt: 'summarize this note',
  schedule: null,
  tool: { type: 'auto' } as ToolChoice,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  ...over,
});

const types = (l: { tools: ToolChoice[] }) => l.tools.map((t) => (t.type === 'cli' ? `cli:${t.cli}` : t.type));

describe('resolveEscalationLadder — hard stops never climb', () => {
  it('secret-guard match → on-device only, no escalation', () => {
    const l = resolveEscalationLadder(mk({ prompt: 'use key sk-ant-api03-AAAABBBBCCCCDDDD now' }), KEYED);
    expect(l.guard).toBe('secret');
    expect(l.noEscalation).toBe(true);
    expect(types(l)).toEqual(['local']);
  });

  it('manual on-device pin → local only, no climb', () => {
    const l = resolveEscalationLadder(mk({ runOn: 'on-device' }), KEYED);
    expect(l.guard).toBe('manual-pin');
    expect(l.noEscalation).toBe(true);
    expect(types(l)).toEqual(['local']);
  });

  it('manual cloud pin → single pinned tool, no climb', () => {
    const l = resolveEscalationLadder(mk({ runOn: 'cloud' }), KEYED);
    expect(l.guard).toBe('manual-pin');
    expect(l.noEscalation).toBe(true);
    expect(l.tools.length).toBe(1);
  });
});

describe('resolveEscalationLadder — autonomous is local → Codex ONLY', () => {
  it('autonomous auto → [local, codex], no key backends', () => {
    const l = resolveEscalationLadder(mk({ autonomous: true }), KEYED);
    expect(l.noEscalation).toBe(false);
    expect(types(l)).toEqual(['local', 'cli:codex']);
  });

  it('autonomous with a configured api-key tool still drops it → [local, codex]', () => {
    const l = resolveEscalationLadder(mk({ autonomous: true, tool: { type: 'perplexity' } }), KEYED);
    expect(types(l)).toEqual(['local', 'cli:codex']);
    expect(types(l)).not.toContain('perplexity');
    expect(types(l)).not.toContain('cerebras');
    expect(types(l)).not.toContain('groq');
  });
});

describe('resolveEscalationLadder — attended ladder (primary → local → free cloud → Codex)', () => {
  it('transform task primary=local, then free cloud (keyed), Codex last', () => {
    const l = resolveEscalationLadder(mk({ prompt: '要約して箇条書きにして' }), KEYED);
    expect(types(l)).toEqual(['local', 'cerebras', 'groq', 'cli:codex']);
    expect(types(l).at(-1)).toBe('cli:codex'); // Codex always terminal (quota-preserving)
  });

  it('academic task tries Perplexity (domain) first, then climbs', () => {
    const l = resolveEscalationLadder(mk({ prompt: 'find the latest research paper with citations' }), KEYED);
    expect(types(l)[0]).toBe('perplexity');
    expect(types(l).at(-1)).toBe('cli:codex');
  });

  it('omits Cerebras/Groq when their key is absent (no wasted hop)', () => {
    const l = resolveEscalationLadder(mk({ prompt: '要約して' }), NO_KEYS);
    expect(types(l)).not.toContain('cerebras');
    expect(types(l)).not.toContain('groq');
    expect(types(l)).toEqual(['local', 'cli:codex']);
  });

  it('only the keyed free-cloud tier is included', () => {
    const l = resolveEscalationLadder(mk({ prompt: '要約して' }), { hasCerebrasKey: false, hasGroqKey: true });
    expect(types(l)).toEqual(['local', 'groq', 'cli:codex']);
  });
});

describe('resolveEscalationLadder — web-mandatory tasks exclude non-web backends', () => {
  it('general collect-news (attended) → Gemini → Codex, no local/cerebras/groq', () => {
    const l = resolveEscalationLadder(mk({ prompt: 'ニュースを集めて' }), KEYED);
    expect(types(l)).toEqual(['gemini-api', 'cli:codex']);
    expect(types(l)).not.toContain('local');
    expect(types(l)).not.toContain('cerebras');
    expect(types(l)).not.toContain('groq');
  });

  it('academic collect (attended) → Perplexity → Codex', () => {
    const l = resolveEscalationLadder(mk({ prompt: '最新の論文を集めて出典付きで' }), KEYED);
    expect(types(l)).toEqual(['perplexity', 'cli:codex']);
  });

  it('autonomous web-mandatory → Codex ONLY (api-key web backends fail-closed)', () => {
    const l = resolveEscalationLadder(mk({ prompt: 'ニュースを集めて', autonomous: true }), KEYED);
    expect(types(l)).toEqual(['cli:codex']);
    expect(types(l)).not.toContain('gemini-api');
    expect(types(l)).not.toContain('local');
  });

  it('N1: autonomous + cloud consent → Gemini→Codex (general) / Perplexity→Codex (academic)', () => {
    const consent: LadderEnv = { hasCerebrasKey: true, hasGroqKey: true, autonomousCloudConsent: true };
    expect(types(resolveEscalationLadder(mk({ prompt: 'ニュースを集めて', autonomous: true }), consent)))
      .toEqual(['gemini-api', 'cli:codex']);
    expect(types(resolveEscalationLadder(mk({ prompt: '最新の論文を集めて', autonomous: true }), consent)))
      .toEqual(['perplexity', 'cli:codex']);
  });

  it("N1: 'stop' policy halts at the free tier (no Codex climb on 429)", () => {
    const consentStop: LadderEnv = { hasCerebrasKey: true, hasGroqKey: true, autonomousCloudConsent: true, autonomousCloudStop: true };
    expect(types(resolveEscalationLadder(mk({ prompt: 'ニュースを集めて', autonomous: true }), consentStop)))
      .toEqual(['gemini-api']);
  });

  it('N1: consent does NOT widen non-web autonomous tasks (still local→Codex)', () => {
    const consent: LadderEnv = { hasCerebrasKey: true, hasGroqKey: true, autonomousCloudConsent: true };
    expect(types(resolveEscalationLadder(mk({ prompt: '要約して', autonomous: true }), consent)))
      .toEqual(['local', 'cli:codex']);
  });

  it('N1: secret-guard still wins over autonomous cloud consent', () => {
    const consent: LadderEnv = { hasCerebrasKey: true, hasGroqKey: true, autonomousCloudConsent: true };
    const l = resolveEscalationLadder(mk({ prompt: 'ニュースを集めて key sk-ant-api03-AAAABBBBCCCCDDDD', autonomous: true }), consent);
    expect(l.guard).toBe('secret');
    expect(types(l)).toEqual(['local']);
  });

  it('secret-guard still wins over a web-mandatory task (no cloud climb)', () => {
    const l = resolveEscalationLadder(mk({ prompt: 'ニュースを集めて key sk-ant-api03-AAAABBBBCCCCDDDD' }), KEYED);
    expect(l.guard).toBe('secret');
    expect(l.noEscalation).toBe(true);
    expect(types(l)).toEqual(['local']);
  });

  it('regression: "検索して" (search) + freshness is web-mandatory → Gemini/Perplexity → Codex, no local/cerebras/groq', () => {
    // Before the COLLECTION_KW fix, this prompt (explicitly asking to search via
    // Perplexity, with a freshness cue) evaluated needsWeb=false and fell through
    // to the general ladder, which could hand it to Groq — a backend with no web
    // access — letting it silently "succeed" without ever searching.
    const l = resolveEscalationLadder(mk({ prompt: 'Perplexityで最新情報を検索して1つにまとめて' }), KEYED);
    expect(types(l)).not.toContain('local');
    expect(types(l)).not.toContain('cerebras');
    expect(types(l)).not.toContain('groq');
    expect(types(l).at(-1)).toBe('cli:codex');

    const l2 = resolveEscalationLadder(mk({ prompt: 'search for the latest news' }), KEYED);
    expect(types(l2)).toEqual(['gemini-api', 'cli:codex']);
  });
});

describe('resolveEscalationLadder — key preflight (G4 P1: keyless cloud degrades upfront)', () => {
  const NO_CLOUD_KEYS: LadderEnv = {
    hasCerebrasKey: false,
    hasGroqKey: false,
    hasPerplexityKey: false,
    hasGeminiKey: false,
  };

  it('auto-scorer research task with no Perplexity key → degrades to local first (no wasted hop)', () => {
    const l = resolveEscalationLadder(
      mk({ prompt: 'find the latest research paper with citations' }),
      NO_CLOUD_KEYS,
    );
    expect(types(l)[0]).toBe('local');
    expect(types(l)).not.toContain('perplexity');
    expect(types(l).at(-1)).toBe('cli:codex');
    expect(l.why).toContain('key not configured');
  });

  it('unknown key state (fields absent) keeps the scorer primary — never wrongly skipped', () => {
    const l = resolveEscalationLadder(
      mk({ prompt: 'find the latest research paper with citations' }),
      NO_KEYS, // hasPerplexityKey/hasGeminiKey absent → unknown → assumed present
    );
    expect(types(l)[0]).toBe('perplexity');
  });

  it('EXPLICITLY configured keyless tool is kept (its missing-key error is the signal)', () => {
    const l = resolveEscalationLadder(
      mk({ tool: { type: 'perplexity', model: 'sonar-deep-research' } }),
      NO_CLOUD_KEYS,
    );
    expect(types(l)[0]).toBe('perplexity');
  });

  it('web-mandatory general task with no Gemini key → Codex directly, local still excluded', () => {
    const l = resolveEscalationLadder(mk({ prompt: 'ニュースを集めて' }), NO_CLOUD_KEYS);
    expect(types(l)).toEqual(['cli:codex']);
    expect(types(l)).not.toContain('local');
  });

  it('web-mandatory academic task with no Perplexity key → Codex directly', () => {
    const l = resolveEscalationLadder(mk({ prompt: '最新の論文を集めて' }), NO_CLOUD_KEYS);
    expect(types(l)).toEqual(['cli:codex']);
  });

  it('N1: autonomous cloud consent with a keyless backend falls to the fail-closed Codex path', () => {
    const consentNoKeys: LadderEnv = { ...NO_CLOUD_KEYS, autonomousCloudConsent: true };
    const l = resolveEscalationLadder(mk({ prompt: 'ニュースを集めて', autonomous: true }), consentNoKeys);
    expect(types(l)).toEqual(['cli:codex']);
    // The why must diagnose the missing key, not suggest enabling the (already
    // enabled) cloud opt-in.
    expect(l.why).toContain('key is not configured');
  });

  it('N1: stop policy does not keep a keyless consented backend (missing key ≠ 429)', () => {
    const consentStopNoKeys: LadderEnv = {
      ...NO_CLOUD_KEYS,
      autonomousCloudConsent: true,
      autonomousCloudStop: true,
    };
    const l = resolveEscalationLadder(mk({ prompt: 'ニュースを集めて', autonomous: true }), consentStopNoKeys);
    expect(types(l)).toEqual(['cli:codex']);
  });

  it('keyed web primary is unchanged by the preflight', () => {
    const l = resolveEscalationLadder(
      mk({ prompt: 'ニュースを集めて' }),
      { ...NO_CLOUD_KEYS, hasGeminiKey: true },
    );
    expect(types(l)).toEqual(['gemini-api', 'cli:codex']);
  });
});

describe('failure detection', () => {
  it('isLocalFallbackDigest matches the shell digest marker', () => {
    expect(isLocalFallbackDigest('# Local Context Fallback\n\nLocal LLM was unavailable...')).toBe(true);
    expect(isLocalFallbackDigest('Here is your summary.')).toBe(false);
    expect(isLocalFallbackDigest(null)).toBe(false);
  });

  it('attemptFailed on an error status OR a fallback digest', () => {
    expect(attemptFailed('error', 'anything')).toBe(true);
    expect(attemptFailed('success', '# Local Context Fallback ...')).toBe(true);
    expect(attemptFailed('success', 'a real answer')).toBe(false);
    expect(attemptFailed('skipped', 'x')).toBe(false);
  });

  it("attemptFailed climbs on a transient 'unavailable' (busy web backend hands off)", () => {
    // 'unavailable' still escalates the ladder (try the next tool) even though it
    // is excluded from the circuit breaker.
    expect(attemptFailed('unavailable', 'a real answer')).toBe(true);
  });

  it('isLowQualityCompletion catches a real on-device prompt-echo failure (regression)', () => {
    // Verbatim (trimmed) shape of what a weak on-device model produced for an
    // orchestrated x.post step on 2026-07-15: it echoed the buildStepPrompt
    // scaffold back instead of answering it, then refused.
    const echoed =
      '# Results from previous steps\n## Step 1\nパープレで STEAM 教育×AI に関する最新の論文やニュースを検索して\n\n' +
      '## Step 2\nローカル LLM で一次ソースと要約を Obsidian の「日付フォルダ」に保存する。\n\n---\n\n' +
      '# This step\nX 用に文字数内で再要約して X に投稿して\n\n---\n\n**Note:** This action requires generating ' +
      'text within a word limit (typically ~1000 characters) for X\'s submission. As an AI, I cannot generate a ' +
      'literal "X" post with a';
    expect(isLowQualityCompletion(echoed)).toBe(true);
    expect(attemptFailed('success', echoed)).toBe(true);
  });

  it('isLowQualityCompletion still catches the echo after whitespace-collapse (regression)', () => {
    // clean_result_preview() in the shell (lib/agent-executor.ts) runs
    // `tr '\n' ' '` on the run preview before anything sees it — a literal
    // '\n' in a marker can never match the real preview shape. This is
    // what an actual whitespace-collapsed on-device preview looks like.
    const collapsed =
      '# Results from previous steps ## Step 1 パープレで検索して ## Step 2 保存する。 --- ' +
      '# This step X用に再要約して投稿して --- Note: As an AI, I cannot generate a literal X post with a';
    expect(isLowQualityCompletion(collapsed)).toBe(true);
  });

  it('isLowQualityCompletion catches a bare refusal with no prompt echo', () => {
    expect(isLowQualityCompletion('As an AI, I cannot generate a literal social media post.')).toBe(true);
    expect(isLowQualityCompletion('私はAIなので、実際の投稿はできません。')).toBe(true);
  });

  it('isLowQualityCompletion does not flag real content', () => {
    expect(isLowQualityCompletion('STEAM教育×AI の最新動向まとめ: 論文3件、ニュース2件を要約しました。')).toBe(false);
    expect(isLowQualityCompletion('This step forward for AI in education looks promising.')).toBe(false);
    expect(isLowQualityCompletion(null)).toBe(false);
    expect(isLowQualityCompletion(undefined)).toBe(false);
  });

  it('isLowQualityCompletion flags empty/whitespace-only text (regression: codex-driver telemetry strip yields empty preview)', () => {
    // 2026-07-15: clean_result_preview() strips every line the codex driver
    // ever prints, so a Codex-routed step that completes successfully can
    // still yield a fully empty preview — previously this matched neither
    // the echo nor the refusal patterns and silently reached the confirm
    // card blank instead of failing loud.
    expect(isLowQualityCompletion('')).toBe(true);
    expect(isLowQualityCompletion('   \n\t  ')).toBe(true);
  });

  it('attemptFailed does not flag a normal successful completion', () => {
    expect(attemptFailed('success', 'STEAM教育×AI の最新動向まとめ、Obsidianに保存しました。')).toBe(false);
  });

  it('isLowQualityCompletion catches the real on-device "honest failure to retrieve data" repro (2026-07-23 battery-notify finding)', () => {
    // Verbatim (trimmed) shape of what Codex CLI reported for the "notify me
    // of battery level" agent — this is NOT a prompt echo and NOT refusal
    // boilerplate (no "as an AI" / "生成できません"), so it read as a
    // complete, natural sentence and previously matched neither pattern set.
    const honestFailure = 'この実行環境では端末のバッテリー情報へアクセスできず、残量を取得できませんでした。';
    expect(isLowQualityCompletion(honestFailure)).toBe(true);
    expect(attemptFailed('success', honestFailure)).toBe(true);
  });

  it('isLowQualityCompletion catches short EN "could not retrieve/access" completions', () => {
    expect(isLowQualityCompletion('I could not retrieve the battery level in this execution environment.')).toBe(true);
    expect(isLowQualityCompletion('Sorry, I was unable to access the battery information.')).toBe(true);
    expect(isLowQualityCompletion("I couldn't retrieve the requested value.")).toBe(true);
    expect(isLowQualityCompletion('There is no access to battery status from this shell.')).toBe(true);
  });

  it('isLowQualityCompletion does NOT flag a long, otherwise-substantive response that merely mentions a similar phrase in passing (explicit negative)', () => {
    // The exact false-positive risk called out for this heuristic: a genuine,
    // otherwise-successful research summary that happens to note ONE
    // unrelated sub-detail was unavailable must not be treated the same as a
    // completion that delivered nothing at all.
    const longGenuineSummary =
      'STEAM教育×AIの最新動向まとめ: 論文3件、ニュース2件を要約しました。' +
      '1件目は初等教育でのAI活用事例、2件目は高校でのプログラミング教育カリキュラム改訂、' +
      '3件目は大学の産学連携プロジェクトについてです。ニュースでは政府の教育予算方針と、' +
      '地方自治体のICT導入状況を取り上げました。なお、この件については詳細情報が取得できません' +
      'でしたので、続報が出次第追跡します。全体として教育現場でのAI活用は着実に進んでいます。';
    expect(isLowQualityCompletion(longGenuineSummary)).toBe(false);
    expect(attemptFailed('success', longGenuineSummary)).toBe(false);

    const longEnglishSummary =
      'Q3 revenue grew 12% year over year, driven by strong enterprise adoption. ' +
      'The APAC region led growth at 18%, while EMEA grew 9%. Customer churn ' +
      'improved to 4.2% from 5.1% last quarter. One regional breakdown for ' +
      'Southeast Asia specifically was unable to access at this time, but the ' +
      'overall trend across all other regions remains strongly positive, with ' +
      'gross margin holding steady at 71% for the third consecutive quarter.';
    expect(isLowQualityCompletion(longEnglishSummary)).toBe(false);
  });

  it('isLowQualityCompletion catches the real on-device "meta-commentary about the delivery action" repro (2026-07-25, bug #158 follow-up)', () => {
    // Verbatim (trimmed) shape of what Qwen3.5-2B reported for the same
    // "notify me about the news" agent AFTER the needsWeb routing fix landed
    // — a direct A/B test against 0.8B on the identical task. Neither the
    // refusal nor data-unavailable pattern sets catch this: it isn't a
    // refusal ("as an AI...") and it isn't an honest "I couldn't get this"
    // — it announces the delivery mechanism itself instead of either
    // delivering real content or admitting it can't.
    expect(isLowQualityCompletion('ニュース通知を送信します。')).toBe(true);
    expect(isLowQualityCompletion('ニュース通知を完了しました。')).toBe(true);
    expect(attemptFailed('success', 'ニュース通知を完了しました。')).toBe(true);
  });

  it('isLowQualityCompletion catches short EN "notification sent/completed" meta-commentary', () => {
    expect(isLowQualityCompletion('The notification has been sent.')).toBe(true);
    expect(isLowQualityCompletion('Notification completed.')).toBe(true);
    expect(isLowQualityCompletion('Sending the notification now.')).toBe(true);
    expect(isLowQualityCompletion('Task completed.')).toBe(true);
  });

  it('isLowQualityCompletion does NOT flag genuine notify content that happens to use similar words (explicit negative)', () => {
    // A real, substantive notification about an actual event — "通知"/
    // "お知らせ" appearing as part of real content, not as a meta-announcement
    // of the delivery action itself, must not be caught.
    expect(isLowQualityCompletion('明日の会議室変更のお知らせです。新しい会議室はB201です。')).toBe(false);
    expect(isLowQualityCompletion('重要なお知らせ：システムメンテナンスは22時から実施されます。')).toBe(false);
    expect(isLowQualityCompletion('Your package delivery notification: arriving between 2-4pm today.')).toBe(false);
  });

  it('isLowQualityCompletion catches the real on-device fabricated command-execution report (2026-07-27, bug #162)', () => {
    // Verbatim (trimmed) shape of what the "Shell Script" agent's Local LLM
    // backend reported for a draft-typed "write X via shell command to
    // /sdcard/probe.txt" task — a fully-detailed but entirely fabricated
    // success transcript. draft has zero real execution capability (the
    // model is only ever told "write the content directly"), and neither
    // the refusal, data-unavailable, nor meta-commentary pattern sets catch
    // this: it isn't a refusal or an honest failure, and it isn't vague
    // present/future "I will send" phrasing — it's a confident past-tense
    // narration of an execution that never happened.
    const shellScriptRepro =
      'Command executed: \'echo "test" > /sdcard/probe.txt\' Status: Success File created at \'/sdcard/probe.txt\' Content: test';
    expect(isLowQualityCompletion(shellScriptRepro)).toBe(true);
    expect(attemptFailed('success', shellScriptRepro)).toBe(true);
  });

  it('isLowQualityCompletion catches the real on-device fabricated shell-prompt transcript (2026-07-27, unattended repro)', () => {
    // Verbatim shape of the SAME bug reproduced a second time, on a
    // genuinely unattended scheduled fire (no RUN NOW tap): the saved
    // draft .md file's content was a fabricated shell-prompt line instead
    // of first-person prose — same fabrication, different surface form.
    const unattendedRepro = "root@docker:~# printf 'test' > /sdcard/probe2.txt";
    expect(isLowQualityCompletion(unattendedRepro)).toBe(true);
    expect(attemptFailed('success', unattendedRepro)).toBe(true);
  });

  it('isLowQualityCompletion catches the JA fabricated-execution phrasing too', () => {
    expect(isLowQualityCompletion('コマンドを実行しました。ステータス: 成功')).toBe(true);
    expect(isLowQualityCompletion('スクリプトを実行完了しました。成功しました。')).toBe(true);
  });

  it('isLowQualityCompletion does NOT flag genuine instructional draft content that merely shows a command (explicit negative)', () => {
    // A real, substantive draft explaining HOW to do something (e.g. a
    // saved how-to note) legitimately shows a command without claiming it
    // was executed — must not be caught just for mentioning a command.
    expect(
      isLowQualityCompletion(
        'ファイルにテキストを書き込むには `echo \'test\' > file.txt` のようなコマンドを使います。' +
          'リダイレクト演算子 > は既存の内容を上書きする点に注意してください。',
      ),
    ).toBe(false);
    expect(
      isLowQualityCompletion(
        'To write text to a file, use a command like `echo \'test\' > file.txt`. ' +
          'Note that the > redirect operator overwrites any existing content.',
      ),
    ).toBe(false);
  });
});

describe('isDeterministicDispatchFailure — P3 UX fix (no pointless double approval)', () => {
  it('flags a cli action exit-127 (command not found / not on PATH) dispatch failure', () => {
    expect(isDeterministicDispatchFailure('cli', 'CLI action failed with exit 127.')).toBe(true);
  });

  it('flags a cli action exit-126 (permission denied / not executable) dispatch failure', () => {
    expect(isDeterministicDispatchFailure('cli', 'CLI action failed with exit 126.')).toBe(true);
  });

  it('flags a cli action blocked by command safety (deterministic, not model-dependent)', () => {
    expect(
      isDeterministicDispatchFailure('cli', 'CLI action was blocked by command safety: rm -rf matches a CRITICAL pattern.'),
    ).toBe(true);
  });

  it('flags the known deterministic intent / dm-reply dispatch messages', () => {
    expect(isDeterministicDispatchFailure('intent', 'Intent action has an invalid mode.')).toBe(true);
    expect(isDeterministicDispatchFailure('intent', 'Intent action is missing a launch target.')).toBe(true);
    expect(isDeterministicDispatchFailure('dm-reply', 'DM-reply target is no longer paired.')).toBe(true);
    expect(isDeterministicDispatchFailure('dm-reply', 'Could not verify the DM-reply pairing.')).toBe(true);
  });

  it('does NOT flag a low-quality/echoed completion for cli — that must keep escalating', () => {
    const echoed = 'As an AI, I cannot generate a literal CLI command for this task.';
    expect(isLowQualityCompletion(echoed)).toBe(true);
    expect(isDeterministicDispatchFailure('cli', echoed)).toBe(false);
  });

  it('does NOT flag dispatch_agent_action\'s own quality-gate message (would double-count with isLowQualityCompletion)', () => {
    expect(
      isDeterministicDispatchFailure('cli', 'CLI action failed with exit 1.') // still matches — sanity check the pattern itself
    ).toBe(true);
    expect(
      isDeterministicDispatchFailure('cli', 'CLI action content looks like a prompt echo or AI refusal, not real content — escalating.'),
    ).toBe(false);
    expect(
      isDeterministicDispatchFailure('dm-reply', 'DM-reply content looks like a prompt echo or AI refusal, not real content — escalating.'),
    ).toBe(false);
  });

  it('is scoped ONLY to cli / intent / dm-reply — draft/notify/webhook/app-act never match, even with the same message shape', () => {
    expect(isDeterministicDispatchFailure('draft', 'CLI action failed with exit 127.')).toBe(false);
    expect(isDeterministicDispatchFailure('notify', 'CLI action failed with exit 127.')).toBe(false);
    expect(isDeterministicDispatchFailure('webhook', 'Webhook dispatch failed with exit 1: connection refused')).toBe(false);
    expect(isDeterministicDispatchFailure('app-act', 'CLI action failed with exit 127.')).toBe(false);
  });

  it('is false for a normal generic error message, null/undefined action type or message', () => {
    expect(isDeterministicDispatchFailure('cli', 'Agent produced no output. Check backend configuration.')).toBe(false);
    expect(isDeterministicDispatchFailure(null, 'CLI action failed with exit 127.')).toBe(false);
    expect(isDeterministicDispatchFailure('cli', null)).toBe(false);
    expect(isDeterministicDispatchFailure('cli', undefined)).toBe(false);
    expect(isDeterministicDispatchFailure(undefined, undefined)).toBe(false);
  });
});

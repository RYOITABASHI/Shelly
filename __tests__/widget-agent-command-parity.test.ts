import * as fs from 'fs';
import * as path from 'path';

// Offline drift gate for the widget ASK → `@agent …` registration handoff
// (2026-07-29). Jest cannot execute the Kotlin side, so — following the
// established convention of __tests__/widget-agent-run-parity.test.ts — these
// checks read the native and JS sources and keep the cross-boundary contract
// coupled until the on-device acceptance pass exercises it end to end:
//
//   ScouterWidgetPromptActivity (detect @agent, record pending, deep link)
//     → ScouterStateStore (one-shot pending record, 2-min expiry)
//     → TerminalEmulatorModule "consumeScouterWidgetAgentCommand"
//     → app/_layout.tsx deep-link `target === 'ai'` branch
//     → store/ai-pane-store.ts pendingExternalPrompt
//     → AIPane claim effect → dispatch() → the EXISTING @agent confirm flow.
const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const activity = read(
  'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/scouter/ScouterWidgetPromptActivity.kt',
);
const stateStore = read(
  'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/scouter/ScouterStateStore.kt',
);
const moduleKt = read(
  'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalEmulatorModule.kt',
);
const moduleTypes = read('modules/terminal-emulator/src/TerminalEmulatorModule.ts');
const manifest = read('modules/terminal-emulator/android/src/main/AndroidManifest.xml');
const layout = read('app/_layout.tsx');
const inputRouter = read('lib/input-router.ts');
const aiPane = read('components/panes/AIPane.tsx');
const stringsEn = read('modules/terminal-emulator/android/src/main/res/values/scouter_strings.xml');
const stringsJa = read('modules/terminal-emulator/android/src/main/res/values-ja/scouter_strings.xml');

describe('widget ASK @agent detection stays a literal twin of the real parser', () => {
  // lib/input-router.ts MENTION_PATTERNS' agent route.
  const jsMatch = /pattern: \/(\^@agent[^/]*)\/i,\s*target: 'agent'/.exec(inputRouter);
  // ScouterWidgetPromptActivity.kt's companion AGENT_MENTION_RE.
  const ktMatch = /AGENT_MENTION_RE = Regex\("""([^"]+)""", RegexOption\.IGNORE_CASE\)/.exec(activity);

  it('both pattern literals exist and are byte-identical', () => {
    expect(jsMatch?.[1]).toBeTruthy();
    expect(ktMatch?.[1]).toBeTruthy();
    // The strongest anti-drift check: the Kotlin raw-string pattern IS the JS
    // pattern source. Change lib/input-router.ts's agent route and this fails
    // until the Kotlin twin is updated in lockstep (and vice versa).
    expect(ktMatch![1]).toBe(jsMatch![1]);
  });

  it('the shared pattern behaves like parseInput on representative inputs', () => {
    // Both sides case-insensitively test the TRIMMED input (parseInput trims;
    // the Kotlin helper trims). `^` anchors at index 0 in both engines for
    // this pattern (no multiline flag on either side).
    const re = new RegExp(ktMatch![1], 'i');
    const cases: Array<[string, boolean]> = [
      ['@agent 毎朝7時にニュースをまとめて', true],
      ['  @agent list', true], // leading whitespace — trimmed before testing
      ['@AGENT status', true],
      ['@Agent 毎晩要約して', true],
      // `\s*` is zero-or-more, so these match — SAME behavior as the real
      // parser (parseInput would route them to the agent handler too).
      ['@agentfoo', true],
      ['@agents please', true],
      ['hello @agent', false], // mid-string mention is not a command
      ['@codex build it', false],
      // The AI Pane also routes @edit/@code to the agent handler; the widget
      // DELIBERATELY does not (see isAgentMentionCommand's doc comment) —
      // in the ASK dialog those far more plausibly mean literal Codex text.
      ['@edit foo', false],
      ['@code bar', false],
      ['ls -la', false],
      ['', false],
    ];
    for (const [input, expected] of cases) {
      expect(re.test(input.trim())).toBe(expected);
    }
  });

  it('the widget helper trims before testing, mirroring parseInput', () => {
    expect(activity).toContain('AGENT_MENTION_RE.containsMatchIn(prompt.trim())');
    expect(inputRouter).toContain('const trimmed = input.trim();');
  });
});

describe('agent-shaped input diverts BEFORE the Codex PTY write; everything else falls through unchanged', () => {
  it('the send handler checks isAgentMentionCommand before sendPrompt', () => {
    const sendHandler = activity.slice(
      activity.indexOf('val send = actionText'),
      activity.indexOf('val actions = LinearLayout'),
    );
    const branchIdx = sendHandler.indexOf('if (isAgentMentionCommand(prompt))');
    const sendPromptIdx = sendHandler.indexOf('sendPrompt(prompt, dialog)');
    expect(branchIdx).toBeGreaterThan(-1);
    expect(sendPromptIdx).toBeGreaterThan(branchIdx);
    // The pre-existing non-agent path is untouched: raw-PTY send plus the
    // dead-Codex queue/resume fallback both still live in sendPrompt.
    expect(activity).toContain('target.session.write("\\u0015")');
    expect(activity).toContain('target.session.paste(prompt)');
    expect(activity).toContain('store.recordWidgetPromptPending(prompt)');
  });

  it('the agent branch never touches the PTY and never registers anything natively', () => {
    const agentFn = activity.slice(
      activity.indexOf('private fun sendAgentCommand'),
      activity.indexOf('// ── Voice input via the OS speech recognizer'),
    );
    expect(agentFn).toContain('recordWidgetAgentCommandPending(command)');
    expect(agentFn).toContain('startActivity(intent)');
    expect(agentFn).not.toContain('.paste(');
    expect(agentFn).not.toContain('session.write');
    // No native registration path exists — confirmation stays in-app.
    expect(activity).not.toContain('createAgent');
    expect(activity).not.toContain('run-agent-');
  });

  it('the deep link URI and the RN handler agree', () => {
    expect(activity).toContain('shelly:///ai?widgetAgentCommand=1');
    expect(layout).toContain("} else if (target === 'ai') {");
    expect(layout).toContain("queryValue(parsed.queryParams?.widgetAgentCommand) === '1'");
    expect(layout).toContain('consumeScouterWidgetAgentCommand');
    // The seed call may carry extra args (e.g. the 'widget-ask' source tag) —
    // assert the seeding itself, not the exact arity.
    expect(layout).toContain('setPendingExternalPrompt(command');
  });
});

describe('the RN drain reuses the EXISTING @agent confirm flow (no second registration path)', () => {
  it('_layout.tsx only seeds the AI Pane — it never confirms/registers a draft itself', () => {
    expect(layout).not.toContain('confirmAgentDraft');
    expect(layout).not.toContain('parseAgentNL');
    expect(layout).not.toContain('parseAgentCommand');
  });

  it('AIPane claims the seed and routes it through the same submit path as typed input', () => {
    expect(aiPane).toContain('takePendingExternalPrompt()');
    // Same submit entrypoint as typed input; extra dispatch options (source
    // tagging) are allowed, a different entrypoint is not.
    expect(aiPane).toContain('handleSubmit(taken.text');
  });

  it('the native pending record is one-shot with the shared 2-minute expiry', () => {
    expect(stateStore).toContain('fun recordWidgetAgentCommandPending(command: String)');
    expect(stateStore).toContain('fun consumeWidgetAgentCommandPending(');
    // Reuses the SAME window as the Codex widget prompt, and the JS-side
    // handoff slot mirrors it (store/ai-pane-store.ts EXTERNAL_PROMPT_STALE_MS).
    const consumeFn = stateStore.slice(
      stateStore.indexOf('fun consumeWidgetAgentCommandPending('),
      stateStore.indexOf('fun recordWidgetAgentRunStarted'),
    );
    expect(consumeFn).toContain('WIDGET_PROMPT_EXPIRE_AFTER_MS');
    expect(consumeFn).toContain('.remove(KEY_WIDGET_AGENT_COMMAND)');
  });

  it('the module bridge exists on both sides of the boundary', () => {
    expect(moduleKt).toContain('AsyncFunction("consumeScouterWidgetAgentCommand")');
    expect(moduleTypes).toContain('consumeScouterWidgetAgentCommand?(): Promise<string | null>;');
  });
});

describe('voice input (RecognizerIntent) is review-first and degrade-gracefully', () => {
  it('launches the OS recognizer, never Shelly\'s Whisper pipeline', () => {
    expect(activity).toContain('RecognizerIntent.ACTION_RECOGNIZE_SPEECH');
    expect(activity).toContain('RecognizerIntent.EXTRA_RESULTS');
    expect(activity).not.toContain('use-speech-input');
  });

  it('recognized text populates the EditText for review — it is never auto-submitted', () => {
    const resultFn = activity.slice(
      activity.indexOf('override fun onActivityResult'),
      activity.indexOf('private fun createUnavailableContent'),
    );
    expect(resultFn).toContain('input.setText(merged)');
    expect(resultFn).not.toContain('sendPrompt(');
    expect(resultFn).not.toContain('sendAgentCommand(');
  });

  it('the mic button is availability-gated instead of crashing when no recognizer exists', () => {
    expect(activity).toContain('if (isSpeechRecognitionAvailable())');
    expect(activity).toContain('resolveActivity(packageManager) != null');
    expect(activity).toContain('scouter_widget_prompt_voice_unavailable');
  });

  it('manifest declares recognizer package visibility and dropped noHistory (result delivery)', () => {
    expect(manifest).toContain('android.speech.action.RECOGNIZE_SPEECH');
    const promptActivityDecl = manifest.slice(
      manifest.indexOf('android:name=".scouter.ScouterWidgetPromptActivity"'),
      manifest.indexOf('ShellyScouterPromptTheme'),
    );
    // noHistory activities never receive onActivityResult — voice results
    // would be silently lost. See the manifest comment for the hygiene
    // attributes that still cover teardown.
    expect(promptActivityDecl).not.toContain('android:noHistory');
  });
});

describe('ja strings cover the ASK/prompt flow (previously fell back to English)', () => {
  const requiredJaKeys = [
    'scouter_ask_agent_chat_short',
    'scouter_ask_agent_chat',
    'scouter_widget_prompt_resume',
    // New keys must land in BOTH locales in lockstep.
    'scouter_widget_prompt_voice',
    'scouter_widget_prompt_voice_unavailable',
    'scouter_widget_prompt_agent_command_failed',
  ];

  it.each(requiredJaKeys)('values-ja defines %s', (key) => {
    expect(stringsJa).toContain(`<string name="${key}">`);
  });

  it.each(requiredJaKeys)('values (en) defines %s', (key) => {
    expect(stringsEn).toContain(`<string name="${key}">`);
  });
});

import * as fs from 'fs';
import * as path from 'path';

// Finding 9 (security audit, LOW / defense-in-depth): AgentActionApprovalBridge.writeHumanReply
// accepted a null expectedRequestSha256 (silently bypassing the content-hash check) and had no
// nonce/replay guard, unlike its structurally-identical sibling AgentEscalationBridge.writeHumanReply
// -- the same "one verifier weaker than its sibling" shape already found and fixed for the
// signed-approval bypass (PR #115) and the request-code allocator race (PR #122). Neither Kotlin
// file compiles in this environment (no Android toolchain), so -- matching this project's existing
// pattern in __tests__/plan-executor-parity.test.ts -- these are source-assertion tests: they read
// the real .kt files and assert the hardened shape is present, byte-for-byte, rather than
// simulating behavior.
describe('AgentActionApprovalBridge — Finding 9 hardening (nonce + non-null hash)', () => {
  const root = path.resolve(__dirname, '..');
  const scouterDir = path.join(
    root,
    'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/scouter',
  );
  const actionBridge = fs.readFileSync(path.join(scouterDir, 'AgentActionApprovalBridge.kt'), 'utf8');
  const escalationBridge = fs.readFileSync(path.join(scouterDir, 'AgentEscalationBridge.kt'), 'utf8');
  const notificationDispatcher = fs.readFileSync(path.join(scouterDir, 'NotificationDispatcher.kt'), 'utf8');
  const widgetPromptActivity = fs.readFileSync(path.join(scouterDir, 'ScouterWidgetPromptActivity.kt'), 'utf8');
  const nonceLedger = fs.readFileSync(path.join(scouterDir, 'ActionNonceLedger.kt'), 'utf8');
  const terminalEmulatorModule = fs.readFileSync(
    path.join(
      root,
      'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalEmulatorModule.kt',
    ),
    'utf8',
  );

  it('no longer accepts a null expectedRequestSha256 (the original bypass)', () => {
    expect(actionBridge).not.toContain('expectedRequestSha256: String?');
    expect(actionBridge).not.toContain('expectedRequestSha256 == null ||');
    expect(actionBridge).toContain('fun writeHumanReply(');
    expect(actionBridge).toContain('expectedRequestSha256: String,');
    expect(actionBridge).toContain('actionNonce: String');
    expect(actionBridge).toContain(
      'require(expectedRequestSha256.matches(HEX_SHA256_RE) && requestSha256 == expectedRequestSha256)',
    );
  });

  it('gained a single-use nonce/replay guard mirroring AgentEscalationBridge', () => {
    // Same ledger as the sibling (ActionNonceLedger, review L1 2026-10-31):
    // SecureRandom-sourced nonces, one per disclosure channel, each bound to
    // the request hash it was minted for; consume() is synchronized and drops
    // EVERY nonce of the key on first use, so a captured/replayed reply
    // action can't be reprocessed twice.
    expect(nonceLedger).toContain('private val secureRandom = SecureRandom()');
    expect(nonceLedger).toMatch(/@Synchronized\s+fun consume\(key: String, nonce: String\?, requestSha256: String\): Boolean/);
    expect(nonceLedger).toContain('it.requestSha256 == requestSha256');
    expect(nonceLedger).toContain('entries.remove(key)');
    expect(actionBridge).toContain('private val actionNonces = ActionNonceLedger()');
    expect(actionBridge).toContain('fun registerNotificationNonce(runId: String, requestSha256: String): String');
    expect(actionBridge).toContain('fun registerAppNonce(runId: String, requestSha256: String): String');
    expect(actionBridge).toContain('fun hasNotificationNonce(runId: String): Boolean');
    expect(actionBridge).toContain('require(actionNonces.consume(runId, actionNonce, requestSha256))');
    expect(actionBridge).not.toContain('pendingActionNonces');

    // The sibling's equivalent guard, to prove this is genuinely the same
    // pattern and not a look-alike.
    expect(escalationBridge).toContain('private val actionNonces = ActionNonceLedger()');
    expect(escalationBridge).toContain('require(actionNonces.consume(nonceKey, actionNonce, requestSha256))');
    expect(escalationBridge).not.toContain('pendingActionNonces');
  });

  it('review L1: an in-app read no longer replaces the notification\'s nonce', () => {
    // App reads register on their own channel; only a notification refresh
    // replaces the notification's nonce.
    expect(nonceLedger).toContain('if (channel == CHANNEL_NOTIFICATION) {\n            list.removeAll { it.channel == CHANNEL_NOTIFICATION }');
    expect(terminalEmulatorModule).toContain('AgentEscalationBridge.registerAppNonce(runId, reqId, requestSha256)');
    expect(terminalEmulatorModule).toContain('AgentActionApprovalBridge.registerAppNonce(runId, requestSha256)');
    expect(terminalEmulatorModule).not.toContain('registerNotificationNonce');
    expect(notificationDispatcher).toContain('AgentEscalationBridge.registerNotificationNonce(request.runId, request.reqId, requestSha256)');
    expect(notificationDispatcher).toContain('AgentActionApprovalBridge.registerNotificationNonce(request.runId, requestSha256)');
    // Clearing a request drops all of its nonces.
    expect(actionBridge).toMatch(/fun clearRequest\(context: Context, runId: String\) \{\s+actionNonces\.clear\(runId\)/);
    expect(escalationBridge).toMatch(/fun clearRequest\(context: Context, runId: String, reqId: String\) \{\s+actionNonces\.clear\(actionNonceKey\(runId, reqId\)\)/);
  });

  it('review H1: notify returns the request exactly as native read it (display = signed bytes)', () => {
    const esc = terminalEmulatorModule.slice(terminalEmulatorModule.indexOf('AsyncFunction("notifyAgentEscalationApprovalNeeded")'));
    expect(esc.slice(0, 1400)).toMatch(/notifyAgentEscalationNeeded\(parsed\)[\s\S]*AgentEscalationBridge\.toMap\(parsed\)\s+\}/);
    const act = terminalEmulatorModule.slice(terminalEmulatorModule.indexOf('AsyncFunction("notifyAgentActionApprovalNeeded")'));
    expect(act.slice(0, 1000)).toMatch(/notifyAgentActionApprovalNeeded\(parsed\)[\s\S]*AgentActionApprovalBridge\.toMap\(parsed\)\s+\}/);
  });

  it('notification Allow/Deny path registers a nonce before it can be tapped, mirroring notifyAgentEscalationNeeded', () => {
    expect(notificationDispatcher).toContain(
      'val needsFreshAction = !AgentActionApprovalBridge.hasNotificationNonce(request.runId)',
    );
    expect(notificationDispatcher).toContain(
      'val actionNonce = AgentActionApprovalBridge.registerNotificationNonce(request.runId, requestSha256)',
    );
    // Both Allow and Deny PendingIntents must carry the nonce, not just Allow.
    expect(notificationDispatcher).toContain(
      'agentActionApprovalPendingIntent(true, request, actionNonce, requestSha256)',
    );
    expect(notificationDispatcher).toContain(
      'agentActionApprovalPendingIntent(false, request, actionNonce, requestSha256)',
    );
    expect(notificationDispatcher).toContain('.putExtra(ScouterWidgetPromptActivity.EXTRA_AGENT_ACTION_NONCE, actionNonce)');
  });

  it('the widget Activity refuses to resolve an approval when the nonce extra is missing or blank', () => {
    expect(widgetPromptActivity).toContain('const val EXTRA_AGENT_ACTION_NONCE');
    expect(widgetPromptActivity).toContain(
      'val actionNonce = intent.getStringExtra(EXTRA_AGENT_ACTION_NONCE)',
    );
    expect(widgetPromptActivity).toContain(
      'if (runId.isBlank() || actionNonce.isNullOrBlank() || expectedRequestSha256.isNullOrBlank())',
    );
    expect(widgetPromptActivity).toContain(
      'AgentActionApprovalBridge.writeHumanReply(this, runId, decision, expectedRequestSha256, actionNonce)',
    );
  });

  it('the in-app review-card path (JS AsyncFunction bridge) mints and threads the same nonce', () => {
    // readAgentActionApprovalRequest mints a nonce the moment the request is
    // disclosed to the human for review, and resolveAgentActionApproval now
    // requires both the hash and the nonce as mandatory (non-null) params --
    // no more silent bypass via an omitted argument.
    expect(terminalEmulatorModule).toContain(
      'val actionNonce = AgentActionApprovalBridge.registerAppNonce(runId, requestSha256)',
    );
    expect(terminalEmulatorModule).toContain(
      'AgentActionApprovalBridge.toMap(parsed) + mapOf("actionNonce" to actionNonce)',
    );
    expect(terminalEmulatorModule).toContain(
      'AsyncFunction("resolveAgentActionApproval") { runId: String, decision: String, expectedRequestSha256: String, actionNonce: String ->',
    );
    expect(terminalEmulatorModule).toContain(
      'AgentActionApprovalBridge.writeHumanReply(context, runId, decision, expectedRequestSha256, actionNonce)',
    );
  });

  it('in-app escalation answer (MONITOR / chat, 2026-10-31) uses the notification\'s writeHumanReply path', () => {
    // read mints a fresh nonce in the same per-(run, req) ledger the
    // notification uses; resolve consumes it through writeHumanReply.
    expect(terminalEmulatorModule).toContain(
      'AsyncFunction("readAgentEscalationRequest") { runId: String, reqId: String ->',
    );
    expect(terminalEmulatorModule).toContain('val actionNonce = AgentEscalationBridge.registerAppNonce(runId, reqId, requestSha256)');
    expect(terminalEmulatorModule).toContain(
      'AgentEscalationBridge.writeHumanReply(context, runId, reqId, decision, actionNonce, expectedRequestSha256)',
    );
    expect(widgetPromptActivity).toContain(
      'AgentEscalationBridge.writeHumanReply(this, runId, reqId, decision, actionNonce, expectedRequestSha256)',
    );
    // The escalation bridge: hash binding + single-use nonce (any channel).
    expect(escalationBridge).toContain('require(actionNonces.consume(nonceKey, actionNonce, requestSha256))');
    // Bug #6: a queued (timed-out) request never re-posts a dismissed notification.
    expect(notificationDispatcher).toContain(
      'if (request.state == "queued" && !isNotificationActive(notificationId)) return',
    );
  });

  it('app/_layout.tsx fails closed instead of passing a missing hash/nonce through as null', () => {
    const rootLayout = fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8');
    expect(rootLayout).not.toContain('request.requestSha256 ?? null');
    expect(rootLayout).toContain('if (!requestSha256 || !actionNonce)');
    expect(rootLayout).toContain(
      "await TerminalEmulator.resolveAgentActionApproval?.(request.runId, 'decline', requestSha256, actionNonce)",
    );
  });
});

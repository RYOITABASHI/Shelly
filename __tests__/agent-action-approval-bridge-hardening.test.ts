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
    // Same ledger shape as the sibling: an in-memory map of single-use,
    // SecureRandom-sourced nonces, consumed via an atomic remove(key, value)
    // so a captured/replayed reply action can't be reprocessed twice.
    expect(actionBridge).toContain('private val pendingActionNonces = ConcurrentHashMap<String, String>()');
    expect(actionBridge).toContain('private val secureRandom = SecureRandom()');
    expect(actionBridge).toContain('fun registerActionNonce(runId: String): String');
    expect(actionBridge).toContain('fun hasActionNonce(runId: String): Boolean');
    expect(actionBridge).toContain('require(!expectedNonce.isNullOrBlank() && expectedNonce == actionNonce)');
    expect(actionBridge).toContain('require(pendingActionNonces.remove(runId, expectedNonce))');

    // The sibling's equivalent guard, to prove this is genuinely the same
    // pattern and not a look-alike.
    expect(escalationBridge).toContain('private val pendingActionNonces = ConcurrentHashMap<String, String>()');
    expect(escalationBridge).toContain('require(!expectedNonce.isNullOrBlank() && expectedNonce == actionNonce)');
    expect(escalationBridge).toContain('require(pendingActionNonces.remove(nonceKey, expectedNonce))');
  });

  it('notification Allow/Deny path registers a nonce before it can be tapped, mirroring notifyAgentEscalationNeeded', () => {
    expect(notificationDispatcher).toContain(
      'val needsFreshAction = !AgentActionApprovalBridge.hasActionNonce(request.runId)',
    );
    expect(notificationDispatcher).toContain(
      'val actionNonce = AgentActionApprovalBridge.registerActionNonce(request.runId)',
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
      'val actionNonce = AgentActionApprovalBridge.registerActionNonce(runId)',
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

  it('app/_layout.tsx fails closed instead of passing a missing hash/nonce through as null', () => {
    const rootLayout = fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8');
    expect(rootLayout).not.toContain('request.requestSha256 ?? null');
    expect(rootLayout).toContain('if (!requestSha256 || !actionNonce)');
    expect(rootLayout).toContain(
      "await TerminalEmulator.resolveAgentActionApproval?.(request.runId, 'decline', requestSha256, actionNonce)",
    );
  });
});

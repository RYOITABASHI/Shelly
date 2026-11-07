/**
 * ClosePawDrafts.kt and its wiring. Kotlin does not run under jest, so like the
 * other closepaw-*-invariants suites these read the source and pin the contract
 * with ClosePaw's ShellySaveDraftReceiver. CI compiles it; the device runs it.
 */
import * as fs from 'fs';
import * as path from 'path';

const dir = path.join(__dirname, '../modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator');
const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');

const drafts = read('ClosePawDrafts.kt');
const handoff = read('ClosePawHandoff.kt');
const results = read('ClosePawRunResults.kt');
const approvals = read('ClosePawShellApprovals.kt');
const service = read('TerminalSessionService.kt');
const home = read('HomeInitializer.kt');

function fn(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = src.indexOf('\n    }\n', start);
  return src.slice(start, next);
}

describe('broadcast contract with ShellySaveDraftReceiver', () => {
  const build = fn(handoff, 'internal fun buildSaveDraftBroadcast(');
  const send = fn(handoff, 'internal fun sendSaveDraftBroadcast(');

  it('names the action, the component and the extras', () => {
    expect(handoff).toContain('const val VARIANT_SAVE_DRAFT_ACTION = "ai.closepaw.action.SHELLY_SAVE_DRAFT"');
    expect(handoff).toContain('const val VARIANT_SAVE_DRAFT_RECEIVER = "ai.closepaw.app.ShellySaveDraftReceiver"');
    expect(handoff).toContain('const val EXTRA_PLATFORM = "platform"');
    expect(handoff).toContain('const val EXTRA_SUBSTACK_SUBDOMAIN = "substack_subdomain"');
    expect(build).toContain('component = ComponentName(PACKAGE, VARIANT_SAVE_DRAFT_RECEIVER)');
    expect(build).toContain('data = file');
    expect(build).toContain('putExtra(EXTRA_CALLER_TOKEN, callerToken(context.applicationContext))');
    expect(build).toContain('putExtra(EXTRA_SHELLY_REQ_ID, reqId)');
    expect(build).toContain('putExtra(EXTRA_SHELLY_RESULT_NONCE, resultNonce)');
  });

  it('omits the subdomain for note, which ClosePaw would refuse', () => {
    expect(build).toContain('if (substackSubdomain != null) putExtra(EXTRA_SUBSTACK_SUBDOMAIN, substackSubdomain)');
  });

  it('is ordered, shares the identity on 34+ and waits longer than a large read', () => {
    expect(send).toContain('if (Build.VERSION.SDK_INT >= 34)');
    expect(send).toContain('setShareIdentityEnabled(true)');
    expect(send).toContain('context.sendOrderedBroadcast(intent, null, opts, receiver, scheduler, RC_NO_RESPONSE, null, null)');
    expect(handoff).toContain('const val SAVE_DRAFT_BROADCAST_TIMEOUT_MS = 15_000L');
  });

  it('never carries allow_main_display and has no activity start', () => {
    for (const body of [build, send, drafts]) {
      expect(body).not.toContain('EXTRA_ALLOW_MAIN_DISPLAY');
      expect(body).not.toContain('startActivity');
      expect(body).not.toContain('ClosePawHandoff.launch');
    }
  });
});

describe('result codes', () => {
  const classify = fn(drafts, 'fun classify(');

  it('17 and 18 are refusals, so the goal path cannot fall back on them either', () => {
    expect(handoff).toContain('DEVICE_LOCKED(17, "device-locked"');
    expect(handoff).toContain('CHROME_IN_USE(18, "chrome-in-use"');
    expect(classify).toContain('code == ClosePawHandoff.RC_NO_RESPONSE || ClosePawHandoff.Refusal.fromCode(code) != null -> SendResult.NOT_STARTED');
  });

  it('no answer in time may mean started, and is never sent again', () => {
    expect(classify).toContain('!answered -> SendResult.MAYBE_STARTED');
    const maybe = drafts.slice(drafts.indexOf('SendResult.MAYBE_STARTED -> {'), drafts.indexOf('SendResult.REFUSED -> {'));
    expect(maybe).toContain('open.drafts.removeFirst()');
    expect(maybe).toContain('runningReqId = draft.reqId');
    expect(maybe).not.toContain('renameTo');
  });

  it('only a run that did not start goes back in the queue', () => {
    expect(drafts.split('sending.renameTo(file)').length - 1).toBe(1);
    const notStarted = drafts.slice(drafts.indexOf('SendResult.NOT_STARTED -> {\n                ClosePawRunResults.forget'));
    expect(notStarted).toContain('sending.renameTo(file)');
    expect(notStarted).toContain('ClosePawRunResults.STATUS_QUEUED');
  });

  it('`.sending` comes before the broadcast and is not read as a queue item', () => {
    const send = fn(drafts, 'private fun send(');
    expect(send.indexOf('file.renameTo(sending)')).toBeLessThan(send.indexOf('sendSaveDraftBroadcast'));
    expect('.shelly-draft-req-1760000000000-0123abcd.sending').not.toMatch(/^\.shelly-draft-req-[0-9]{10,16}-[0-9a-f]{8}$/);
    expect(drafts).toContain('Regex("^\\\\.shelly-draft-req-[0-9]{10,16}-[0-9a-f]{8}$")');
  });
});

describe('uncertain', () => {
  it('is a status ClosePaw may report, with its own message', () => {
    expect(results).toContain('const val STATUS_UNCERTAIN = "uncertain"');
    expect(results).toContain('STATUS_UNCERTAIN -> "ClosePaw could not confirm the result');
  });

  it('the shim calls it unknown, and says not to send again', () => {
    expect(home).toContain("'uncertain': 'UNKNOWN - the draft may or may not exist");
    expect(home).toContain("|| status === 'queued';");
  });

  it('counts as check-by-hand, like timeout and lost', () => {
    expect(fn(drafts, 'private fun tally(')).toContain(
      'ClosePawRunResults.STATUS_UNCERTAIN, ClosePawRunResults.STATUS_TIMEOUT, ClosePawRunResults.STATUS_LOST -> open.check++',
    );
  });

  it('every final path reaches the queue', () => {
    expect(results.split('ClosePawDrafts.onRunFinished(').length - 1).toBe(2);
  });
});

describe('the file', () => {
  const send = fn(drafts, 'private fun send(');

  it('is granted before sending, through the existing provider, and revoked with the snapshot', () => {
    expect(drafts).toContain('"${app.packageName}.shelly.fileprovider"');
    expect(drafts).toContain('File(File(app.cacheDir, "share"), "draft-$reqId")');
    expect(send.indexOf('app.grantUriPermission(ClosePawHandoff.PACKAGE, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)'))
      .toBeLessThan(send.indexOf('sendSaveDraftBroadcast'));
    const revoke = fn(drafts, 'private fun revokeAndDelete(');
    expect(revoke).toContain('app.revokeUriPermission(ClosePawHandoff.PACKAGE, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)');
    expect(drafts).toContain('dir.deleteRecursively()');
  });

  it('is the approved content: re-read, hashed and compared right before serving', () => {
    expect(send.indexOf('current != draft')).toBeLessThan(send.indexOf('serve(app, draft.reqId, item.request)'));
    expect(drafts).toContain('ApprovedDraft(reqId, platform, selector, sha256(request))');
  });

  it('the limits match ClosePaw', () => {
    expect(drafts).toContain('const val MAX_REQUEST_BYTES = 16 * 1024 * 1024');
    expect(drafts).toContain('private const val MAX_TITLE_CHARS = 300');
    expect(drafts).toContain('private const val MAX_HTML_CHARS = 1024 * 1024');
    expect(drafts).toContain('private const val MAX_IMAGES = 4');
    expect(drafts).toContain('private const val MAX_IMAGE_HOSTS = 8');
    expect(drafts).toContain('setOf("version", "title", "html", "images", "image_hosts")');
  });
});

describe('authorization', () => {
  it('the queue only ever reaches ClosePaw through an approved batch', () => {
    expect(drafts.split('sendSaveDraftBroadcast(').length - 1).toBe(1);
    expect(fn(drafts, 'private fun unlockStep(')).toContain('ClosePawShellApprovals.create(app, batchId, batchGoal(items), drafts = items.map { it.draft })');
    expect(fn(drafts, 'fun onBatchDecided(')).toContain('if (approved) {');
    expect(approvals).toContain('ClosePawDrafts.onBatchDecided(context.applicationContext, drafts, decision == "approve")');
  });

  it('the terminal still cannot approve', () => {
    const resolve = fn(approvals, 'fun resolve(');
    expect(resolve.indexOf('if (decision == "approve") return Outcome(false, "device-approval-required"'))
      .toBeLessThan(resolve.indexOf('ClosePawDrafts.onBatchDecided'));
  });

  it('nothing in the approval path is auto-accepted', () => {
    expect(drafts).not.toMatch(/autoApprove|autoAccept|preapprov/i);
    expect(drafts).not.toContain('onBatchDecided(app');
  });

  it('the approval text shows the destination and a content hash', () => {
    const goal = fn(drafts, 'private fun batchGoal(');
    expect(goal).toContain('"substack ${d.subdomain}"');
    expect(goal).toContain('d.sha256.take(8)');
    expect(goal).toContain('ClosePawRunResults.sanitizeSummary(item.title)');
  });

  it('the Substack subdomain comes from the device file; a selector only names an entry', () => {
    expect(drafts).toContain('const val DESTINATIONS_FILE = ".shelly/agents/draft-destinations.json"');
    expect(drafts).toContain('if (selector != null) selector.takeIf { it in allowed } else allowed.singleOrNull()');
    expect(fn(drafts, 'private fun send(')).toContain('draft.platform, draft.subdomain, draft.reqId, nonce');
  });

  it('image hosts come from the same file, at queue time and again before sending', () => {
    expect(drafts.split('destinations.imageHosts.containsAll(item.imageHosts)').length - 1).toBe(2);
  });

  it('honours STOP-ALL before asking and before sending', () => {
    expect(fn(drafts, 'private fun unlockStep(')).toContain('isHalted(app)');
    expect(drafts).toContain('if (isHalted(app) || !ClosePawDecisionReceiver.isUnlocked(app)) return');
  });
});

describe('summary', () => {
  it('reads only two counts, never the text', () => {
    const missing = fn(drafts, 'fun imagesMissing(');
    expect(missing).toContain('o.optInt("images_placed", 0) < o.optInt("images_expected", 0)');
    expect(drafts.split('imagesMissing(').length - 1).toBe(2);
  });

  it('logs neither the title nor the article', () => {
    for (const line of drafts.split('\n').filter((l) => l.includes('Log.'))) {
      expect(line).not.toMatch(/title|html|request\)|summary/i);
    }
  });
});

describe('the unlock trigger', () => {
  it('is a runtime ACTION_USER_PRESENT receiver the foreground service holds', () => {
    expect(service).toContain('IntentFilter(Intent.ACTION_USER_PRESENT)');
    expect(service).toContain('registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)');
    expect(service).toContain('ClosePawDrafts.onUnlock(context.applicationContext)');
    expect(service).toContain('unregisterReceiver(it)');
  });

  it('keeps the service alive while drafts wait for that unlock', () => {
    expect(fn(service, 'private fun hasProtectedWork()').length).toBeGreaterThan(0);
    expect(service).toContain('ClosePawDrafts.hasWork(applicationContext)');
  });
});

describe('the shell command', () => {
  it('is extracted and reachable from the helper', () => {
    expect(home).toContain('context.assets.open("shelly-save-draft.js")');
    expect(home).toContain("if (args[0] === 'save-draft') {");
    expect(home).toContain('# SHELLY_HELPER_SHIM v25');
    expect(Number(home.match(/private const val BASHRC_VERSION = (\d+)/)![1])).toBeGreaterThanOrEqual(290);
  });
});

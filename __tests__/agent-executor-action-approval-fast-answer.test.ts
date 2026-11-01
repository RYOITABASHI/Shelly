/**
 * On-device bug (build 2746): a "承認なしで実行" (run-without-approval) agent's
 * `draft` action approval was auto-accepted by RN, yet the run failed with
 * "draft action approval reply did not match the pending request."
 *
 * Root cause: write_action_approval_request() published the request file
 * (mv) and only THEN hashed it into ACTION_APPROVAL_REQUEST_SHA256. An RN
 * auto-answer (run-without-approval / autoAccept / POLICY-001) lands within
 * one 500ms drain tick, and native resolveAgentActionApproval deletes the
 * request file right after writing the signed reply (clearRequest). The
 * post-publish hash (a linker64 node start on device) then read a missing
 * file, came back empty, and wait_action_approval rejected the correctly
 * signed reply as a mismatch. A human tap never answers that fast, which is
 * why the typed-OK / notification path worked.
 *
 * These tests run the REAL emitted write_action_approval_request() +
 * wait_action_approval() with a `mv` that simulates native answering (sign
 * over the published bytes, then delete the request) the instant the request
 * is published — the fastest possible answer.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { Agent, ToolChoice } from '@/store/types';

function agent(): Agent {
  return {
    id: 'fast-t',
    name: 'Fast Answer',
    description: '',
    prompt: 'hi',
    schedule: null,
    tool: { type: 'local' } as ToolChoice,
    outputPath: '~/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
    action: { type: 'draft' },
  } as Agent;
}

function extractFunction(script: string, fnName: string): string {
  const marker = `\n${fnName}() {`;
  const fnStart = script.indexOf(marker);
  if (fnStart === -1) throw new Error(`${fnName} not found in generated script`);
  const lines = script.slice(fnStart + 1).split('\n');
  let heredocTerm: string | null = null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (heredocTerm !== null) {
      if (line === heredocTerm) heredocTerm = null;
      continue;
    }
    const heredocMatch = line.match(/<<-?\s*'?"?([A-Z_]+)'?"?/);
    if (heredocMatch) {
      heredocTerm = heredocMatch[1];
      continue;
    }
    if (line === '}') {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error(`closing brace for ${fnName} not found`);
  return lines.slice(0, end + 1).join('\n');
}

const nodeBin = process.execPath.replace(/\\/g, '/');

function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function toBashPath(p: string): string {
  return p.replace(/\\/g, '/');
}

describe('write_action_approval_request + an instant answer (build 2746 run-without-approval draft)', () => {
  let tmpRoot: string;
  let pubDerPath: string;
  let pubDerSha256: string;
  let privPemPath: string;
  let fns: string;

  beforeAll(() => {
    const s = generateRunScript(agent());
    fns = ['json_escape_text', 'sha256_file', 'json_field_file', 'write_action_approval_request', 'verify_action_approval_reply', 'wait_action_approval']
      .map((n) => extractFunction(s, n))
      .join('\n');
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-fast-answer-'));
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const der = pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    pubDerPath = path.join(tmpRoot, 'pub.der');
    fs.writeFileSync(pubDerPath, der);
    pubDerSha256 = crypto.createHash('sha256').update(der).digest('hex');
    privPemPath = path.join(tmpRoot, 'priv.pem');
    fs.writeFileSync(privPemPath, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Mirrors AgentActionApprovalBridge.writeHumanReply + clearRequest. */
  const nativeAnswer = `
const fs = require('fs');
const crypto = require('crypto');
const [requestFile, replyFile, keyFile, decision] = process.argv.slice(2);
const bytes = fs.readFileSync(requestFile);
const json = JSON.parse(bytes.toString('utf8'));
const requestSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const message = [json.runId, decision, json.ts, requestSha256].join('\\n');
const signature = crypto.sign('RSA-SHA256', Buffer.from(message, 'utf8'), fs.readFileSync(keyFile, 'utf8')).toString('base64');
fs.writeFileSync(replyFile, JSON.stringify({ runId: json.runId, decision, by: 'human', requestSha256, requestTs: json.ts, sigAlg: 'SHA256withRSA', signature }) + '\\n');
fs.unlinkSync(requestFile);
`;

  function run(opts: { decision: 'accept' | 'decline'; brokenHash?: boolean }): { exitOk: boolean; status: string; message: string } {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
    const runId = 'agent-fast-t-1793495021-6187';
    const reqDir = path.join(dir, 'req');
    const replyDir = path.join(dir, 'reply');
    const requestFile = path.join(reqDir, `action-${runId}.json`);
    const replyFile = path.join(replyDir, `action-${runId}.reply.json`);
    const answerJs = path.join(dir, 'answer.js');
    fs.writeFileSync(answerJs, nativeAnswer);
    const scriptPath = path.join(dir, 'run.sh');
    const wrapper = `node_usable() { return 0; }
shelly_node() { "${nodeBin}" "$@"; }
write_native_notification_request() { return 0; }
# The request is answered (and deleted) the instant it is published.
mv() {
  command mv "$@" || return $?
  case "$2" in
    *.json) "${nodeBin}" ${sh(toBashPath(answerJs))} "$2" ${sh(toBashPath(replyFile))} ${sh(toBashPath(privPemPath))} ${sh(opts.decision)} ;;
  esac
}
AGENT_ID='fast-t'
AGENT_NAME='Fast Answer'
TOOL_LABEL='local'
LOG_DIR=${sh(toBashPath(path.join(dir, 'logs')))}
ACTION_RUN_ID=${sh(runId)}
ACTION_APPROVAL_DIR=${sh(toBashPath(reqDir))}
ACTION_APPROVAL_REPLY_DIR=${sh(toBashPath(replyDir))}
ACTION_APPROVAL_REQUEST_FILE=${sh(toBashPath(requestFile))}
ACTION_APPROVAL_REPLY_FILE=${sh(toBashPath(replyFile))}
ACTION_APPROVAL_REQUEST_SHA256=""
ACTION_APPROVAL_PUBLIC_KEY_FILE=${sh(toBashPath(pubDerPath))}
ACTION_APPROVAL_PUBLIC_KEY_SHA256=${sh(pubDerSha256)}
ACTION_APPROVAL_TIMEOUT_SECONDS=5
ACTION_APPROVAL_MODE=manual
ACTION_DISPATCH_STATUS=""
ACTION_DISPATCH_MESSAGE=""
${fns}
${opts.brokenHash ? 'sha256_file() { printf "not-a-hash"; }' : ''}
write_action_approval_request "draft" "hello" "/tmp/result.md" "" "" "false"
if wait_action_approval "draft"; then
  echo EXIT_OK=1
else
  echo EXIT_OK=0
fi
echo "STATUS=$ACTION_DISPATCH_STATUS"
echo "MESSAGE=$ACTION_DISPATCH_MESSAGE"
`;
    fs.writeFileSync(scriptPath, wrapper, 'utf8');
    const out = execFileSync('bash', [scriptPath], { stdio: 'pipe' }).toString('utf8');
    return {
      exitOk: /EXIT_OK=1/.test(out),
      status: /STATUS=(\w*)/.exec(out)?.[1] ?? '',
      message: /MESSAGE=(.*)/.exec(out)?.[1] ?? '',
    };
  }

  it('an accept signed and the request deleted before the script could re-read it is honoured', () => {
    const result = run({ decision: 'accept' });
    expect(result.message).toBe('');
    expect(result.exitOk).toBe(true);
  });

  it('an instant decline is a decline, not a mismatch', () => {
    const result = run({ decision: 'decline' });
    expect(result.exitOk).toBe(false);
    expect(result.status).toBe('skipped');
    expect(result.message).toContain('declined');
  });

  it('still fails closed when the request hash cannot be computed (no hash ⇒ no accept)', () => {
    const result = run({ decision: 'accept', brokenHash: true });
    expect(result.exitOk).toBe(false);
    expect(result.status).toBe('error');
    expect(result.message).toContain('did not match the pending request');
  });

  it('hashes the request before publishing it (source order)', () => {
    const fn = extractFunction(generateRunScript(agent()), 'write_action_approval_request');
    const hashAt = fn.indexOf('ACTION_APPROVAL_REQUEST_SHA256="$(sha256_file "$tmp"');
    const mvAt = fn.indexOf('mv "$tmp" "$ACTION_APPROVAL_REQUEST_FILE"');
    expect(hashAt).toBeGreaterThan(-1);
    expect(mvAt).toBeGreaterThan(hashAt);
    expect(fn).not.toContain('sha256_file "$ACTION_APPROVAL_REQUEST_FILE"');
  });
});

describe('shelly-plan-executor.js action approval request hash', () => {
  for (const rel of ['scripts/shelly-plan-executor.js', 'modules/terminal-emulator/android/src/main/assets/shelly-plan-executor.js']) {
    it(`${rel} hashes the request text before writeAtomic publishes it`, () => {
      const src = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
      const hashAt = src.indexOf("const requestSha256 = sha256Hex(Buffer.from(requestText, 'utf8'));");
      const writeAt = src.indexOf('writeAtomic(requestFile, requestText);');
      expect(hashAt).toBeGreaterThan(-1);
      expect(writeAt).toBeGreaterThan(hashAt);
      expect(src).not.toContain('const requestSha256 = sha256File(requestFile);');
    });
  }
});

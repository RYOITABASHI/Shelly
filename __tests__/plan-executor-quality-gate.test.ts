jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION } from '@/lib/agent-plan-spec';

const root = path.resolve(__dirname, '..');
const executor = path.join(root, 'scripts', 'shelly-plan-executor.js');
const broker = path.join(root, 'scripts', 'shelly-capability-broker.js');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isLowQualityCompletion, isDuplicateOfPriorStep } = require(executor);

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-plan-executor-quality-'));
  fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
  return home;
}

function makePlan(home: string, port: number) {
  const agentId = 'agent-plan-quality';
  const plan = {
    kind: PLAN_SPEC_KIND,
    schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
    generatedAt: 1,
    agent: { id: agentId, name: 'Plan Quality', autonomous: true, autonomyLevel: 'L2', requireActionApproval: true },
    prompt: 'say hello',
    tool: { type: 'local', label: 'Local LLM', model: 'fixture' },
    action: { type: 'draft' },
    paths: { home },
    output: {
      outputDir: path.join(home, 'agent-output'),
      outputNameTemplate: '{date}-{slug}',
      slug: 'plan-quality',
      useGlobalOutput: true,
      suggestedRoots: [],
    },
    limits: { timeoutSeconds: 30, maxConcurrent: 2 },
    policy: { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [] },
    routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
  };
  const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${agentId}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  fs.writeFileSync(path.join(home, '.shelly/agents/.env'), `LOCAL_LLM_URL='http://127.0.0.1:${port}'\n`);
  return { plan, planFile };
}

function runExecutor(
  args: string[],
  home: string,
  envOverride: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, args, {
      env: { ...process.env, HOME: home, ...envOverride },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (status: number | null) => resolve({ status, stdout, stderr }));
  });
}

describe('isLowQualityCompletion (pure)', () => {
  it('flags the prompt-echo scaffold markers from buildStepPrompt', () => {
    expect(isLowQualityCompletion('# Results from previous steps\nstep 1: foo')).toBe(true);
    expect(isLowQualityCompletion('intro\n# This step\ndo the thing')).toBe(true);
  });

  it('flags EN and JA refusal boilerplate', () => {
    expect(isLowQualityCompletion('As an AI, I cannot generate a real post for you.')).toBe(true);
    expect(isLowQualityCompletion("I'm not able to post this on your behalf.")).toBe(true);
    expect(isLowQualityCompletion('私はAIなので投稿できません。')).toBe(true);
  });

  it('does not flag real content', () => {
    expect(isLowQualityCompletion('Here is a great update about our new feature launch today.')).toBe(false);
    expect(isLowQualityCompletion(null)).toBe(false);
    expect(isLowQualityCompletion(undefined)).toBe(false);
  });

  it('flags empty/whitespace-only completions (regression: codex-driver telemetry strip yields empty preview)', () => {
    expect(isLowQualityCompletion('')).toBe(true);
    expect(isLowQualityCompletion('   \n\t  ')).toBe(true);
  });

  // 2026-08-06: this JS copy previously stopped at the four checks above,
  // while the canonical lib/agent-escalation-ladder.ts copy (and the
  // hand-synced bash copy in lib/agent-executor.ts's generated script) grew
  // six more failure-family detectors over 2026-07-23..28 on-device findings.
  // Ported here verbatim (same literal repro strings as
  // __tests__/agent-escalation-ladder.test.ts) so all three copies actually
  // agree, per the "three copies must stay in sync" comment above
  // isLowQualityCompletion in this same file — a claim that was false until
  // this fix (Fable5/Codex 2026-08-06 Hermes-parity re-review finding: the
  // unattended PlanSpec executor's quality gate was materially weaker than
  // the attended path's, so a fabricated-success run fired via schedule could
  // still slip through even though the identical content would be caught for
  // a human-watched run).

  it('catches the on-device "honest failure to retrieve data" repro (2026-07-23 battery-notify finding)', () => {
    const honestFailure = 'この実行環境では端末のバッテリー情報へアクセスできず、残量を取得できませんでした。';
    expect(isLowQualityCompletion(honestFailure)).toBe(true);
    expect(isLowQualityCompletion('I could not retrieve the battery level in this execution environment.')).toBe(true);
  });

  it('does NOT flag a long, otherwise-substantive response that merely mentions a similar phrase in passing (explicit negative)', () => {
    const longGenuineSummary =
      'STEAM教育×AIの最新動向まとめ: 論文3件、ニュース2件を要約しました。' +
      '1件目は初等教育でのAI活用事例、2件目は高校でのプログラミング教育カリキュラム改訂、' +
      '3件目は大学の産学連携プロジェクトについてです。ニュースでは政府の教育予算方針と、' +
      '地方自治体のICT導入状況を取り上げました。なお、この件については詳細情報が取得できません' +
      'でしたので、続報が出次第追跡します。全体として教育現場でのAI活用は着実に進んでいます。';
    expect(isLowQualityCompletion(longGenuineSummary)).toBe(false);
  });

  it('catches the on-device "meta-commentary about the delivery action" repro (2026-07-25, bug #158 follow-up)', () => {
    expect(isLowQualityCompletion('ニュース通知を送信します。')).toBe(true);
    expect(isLowQualityCompletion('ニュース通知を完了しました。')).toBe(true);
    expect(isLowQualityCompletion('The notification has been sent.')).toBe(true);
  });

  it('does NOT flag genuine notify content that happens to use similar words (explicit negative)', () => {
    expect(isLowQualityCompletion('明日の会議室変更のお知らせです。新しい会議室はB201です。')).toBe(false);
    expect(isLowQualityCompletion('重要なお知らせ：システムメンテナンスは22時から実施されます。')).toBe(false);
  });

  it('catches the on-device fabricated command-execution report (2026-07-27, bug #162)', () => {
    const shellScriptRepro =
      'Command executed: \'echo "test" > /sdcard/probe.txt\' Status: Success File created at \'/sdcard/probe.txt\' Content: test';
    expect(isLowQualityCompletion(shellScriptRepro)).toBe(true);
    expect(isLowQualityCompletion("root@docker:~# printf 'test' > /sdcard/probe2.txt")).toBe(true);
    expect(isLowQualityCompletion('コマンドを実行しました。ステータス: 成功')).toBe(true);
  });

  it('catches the on-device bare-command-line and bare-redirect repros (2026-07-28, third/fourth fabrication shapes)', () => {
    expect(isLowQualityCompletion('echo "Test executed" > /sdcard/probe3.txt')).toBe(true);
    expect(isLowQualityCompletion('cat /etc/hosts | grep localhost')).toBe(true);
    expect(isLowQualityCompletion('> /sdcard/probe4.txt')).toBe(true);
    expect(isLowQualityCompletion('| grep secret')).toBe(true);
  });

  it('does NOT flag a bare non-command line or genuine prose that merely contains > or | mid-sentence (explicit negative)', () => {
    expect(isLowQualityCompletion('こんにちは、今日は晴れです。')).toBe(false);
    expect(isLowQualityCompletion('git is a distributed version control system')).toBe(false);
    expect(isLowQualityCompletion('売上は前年比で50%以上伸びました。')).toBe(false);
  });

  it('does NOT flag genuine instructional draft content that merely shows a command (explicit negative)', () => {
    expect(
      isLowQualityCompletion(
        'ファイルにテキストを書き込むには `echo \'test\' > file.txt` のようなコマンドを使います。' +
          'リダイレクト演算子 > は既存の内容を上書きする点に注意してください。',
      ),
    ).toBe(false);
  });

  it('catches the on-device fenced-shell-transcript repro (2026-07-28, fifth fabrication shape)', () => {
    const fencedRepro = "```text\ncd /sdcard\necho 'test' > probe_verify.txt\ncat probe_verify.txt\n```";
    expect(isLowQualityCompletion(fencedRepro)).toBe(true);
    expect(isLowQualityCompletion('```\nrm -f /tmp/x; touch /tmp/x\n```')).toBe(true);
  });

  it('does NOT flag a legitimate fenced code answer, with or without surrounding prose (explicit negative)', () => {
    expect(isLowQualityCompletion('```python\nfor i in range(1, 101):\n    print(i)\n```')).toBe(false);
    expect(isLowQualityCompletion('```json\n{"key": "value"}\n```')).toBe(false);
    expect(
      isLowQualityCompletion(
        '以下のコマンドでファイルを作成できます。\n```text\necho \'test\' > file.txt\n```\n' +
          '上書きされる点にご注意ください。',
      ),
    ).toBe(false);
  });

  it('catches the on-device execution-narrative repro (2026-07-28, SIXTH fabrication shape)', () => {
    const narrativeRepro =
      'この依頼を履行するため、以下の手順で Shell コマンドを実行します。\n\n' +
      '### 手順：シェルコマンドを実行\n\n' +
      '```bash\n# 現在の時刻を記録\necho "2026年07月28日(火) 18:10 JST" > /sdcard/probe_verify2.txt\n' +
      'cat /sdcard/probe_verify2.txt\n```\n\n' +
      '### 実行結果の確認\n\n上記の命令を再度実行します。';
    expect(isLowQualityCompletion(narrativeRepro)).toBe(true);
  });

  it('sixth shape requires BOTH the first-person execution claim AND a shell-command fence (explicit negatives)', () => {
    expect(
      isLowQualityCompletion(
        '以下のコマンドを実行してください。\n```bash\necho \'test\' > file.txt\n```\n' +
          '実行すると file.txt が作成されます。',
      ),
    ).toBe(false);
    expect(
      isLowQualityCompletion('このスクリプトを実行します。\n```python\nprint("hello")\n```\n以上です。'),
    ).toBe(false);
  });
});

describe('isDuplicateOfPriorStep / normalizeForDuplicateCheck (pure, ported from lib/agent-escalation-ladder.ts)', () => {
  it('flags an exact match (after trim/whitespace/case normalization)', () => {
    const prior = 'Explorative Modelingの成果を発表、データ効率が6.2倍。';
    const current = '  explorative modelingの成果を発表、データ効率が6.2倍。  ';
    expect(isDuplicateOfPriorStep(current, prior)).toBe(true);
  });

  it('flags a near-verbatim repeat where the current step is fully contained in the prior step (2026-08-04 real incident shape)', () => {
    const prior =
      '日本の研究チーム「Explorative Modeling」の成果を発表、データ効率が6.2倍。経産省の組織再編も発表された。';
    const current = '日本の研究チーム「Explorative Modeling」の成果を発表、データ効率が6.2倍。';
    expect(isDuplicateOfPriorStep(current, prior)).toBe(true);
  });

  it('does NOT flag containment when the longer text adds substantial new content (net-new info, not a repeat)', () => {
    const prior = 'Q3 revenue grew 12% year over year.';
    const current = 'Q3 revenue grew 12% year over year. Also, churn improved to 4.2% and APAC led growth at 18%.';
    expect(isDuplicateOfPriorStep(current, prior)).toBe(false);
  });

  it('does NOT flag short strings — too little signal to judge reliably (avoids false positives on short "OK"-style acks)', () => {
    expect(isDuplicateOfPriorStep('Done.', 'Done.')).toBe(false);
    expect(isDuplicateOfPriorStep('OK', 'OK')).toBe(false);
  });

  it('is false when there is no prior content (first step / non-orchestrated run)', () => {
    expect(isDuplicateOfPriorStep('Some perfectly normal, reasonably long completion text here.', undefined)).toBe(false);
    expect(isDuplicateOfPriorStep('Some perfectly normal, reasonably long completion text here.', null)).toBe(false);
  });
});

describe('shelly-plan-executor quality gate blocks dispatch (PlanSpec path)', () => {
  let server: http.Server;
  let port = 0;
  let requestCount = 0;
  // Set by each test before the model request lands, to control the fixture's
  // canned "model" response independent of the plan prompt.
  let fixtureContent = '';

  beforeEach((done) => {
    requestCount = 0;
    fixtureContent = '';
    server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        requestCount += 1;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          choices: [{ message: { content: fixtureContent } }],
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      port = typeof address === 'object' && address ? address.port : 0;
      done();
    });
  });

  afterEach((done) => {
    server.close(done);
  });

  it('blocks a webhook dispatch when the completion is a prompt echo, without sending or requesting approval', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    fixtureContent = '# Results from previous steps\nstep 1: draft the post\n# This step\nPost this to X.';
    (plan as any).action = { type: 'webhook', webhookUrl: 'https://hooks.example.test/incoming' };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

    const result = await runExecutor([
      executor, '--plan-file', planFile, '--home', home, '--agent-id', plan.agent.id, '--broker', broker,
    ], home);

    expect(result.status).toBe(0);
    // No approval request was ever created — the gate fires before dispatch.
    const requestDir = path.join(home, '.shelly/agents/action-approvals');
    expect(fs.existsSync(requestDir) ? fs.readdirSync(requestDir) : []).toHaveLength(0);

    const logDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const runLogName = fs.readdirSync(logDir).find((name) => /^\d+\.json$/.test(name))!;
    const runLog = JSON.parse(fs.readFileSync(path.join(logDir, runLogName), 'utf8'));
    expect(runLog.status).toBe('error');
    expect(runLog.errorMessage).toContain('prompt echo or AI refusal');

    const notify = JSON.parse(fs.readFileSync(path.join(logDir, 'native-result-notification.json'), 'utf8'));
    expect(notify.status).toBe('error');
    expect(notify.preview).toContain('prompt echo or AI refusal');
  });

  it('blocks a dm-reply dispatch when the completion is refusal boilerplate, without requesting approval', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    fixtureContent = 'As an AI, I cannot generate a real reply for you.';
    (plan as any).action = { type: 'dm-reply', dmPairingId: 'pair-1', dmReplyText: 'Reply: {{result}}' };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
    fs.writeFileSync(path.join(home, '.shelly/agents/dm-pairings.json'), JSON.stringify([
      { id: 'pair-1', label: 'Test conversation', revoked: false },
    ]));

    const result = await runExecutor([
      executor, '--plan-file', planFile, '--home', home, '--agent-id', plan.agent.id, '--broker', broker,
    ], home);

    expect(result.status).toBe(0);
    const requestDir = path.join(home, '.shelly/agents/action-approvals');
    expect(fs.existsSync(requestDir) ? fs.readdirSync(requestDir) : []).toHaveLength(0);

    const logDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const runLogName = fs.readdirSync(logDir).find((name) => /^\d+\.json$/.test(name))!;
    const runLog = JSON.parse(fs.readFileSync(path.join(logDir, runLogName), 'utf8'));
    expect(runLog.status).toBe('error');
    expect(runLog.errorMessage).toContain('prompt echo or AI refusal');
  });

  it('blocks a draft dispatch when the completion is a prompt echo, without writing the vault file', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    fixtureContent = '# Results from previous steps\nstep 1: draft the article\n# This step\nWrite the summary.';
    (plan as any).action = { type: 'draft' };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

    const result = await runExecutor([
      executor, '--plan-file', planFile, '--home', home, '--agent-id', plan.agent.id, '--broker', broker,
    ], home);

    expect(result.status).toBe(0);
    // The gate fires before dispatch — no approval request and no draft file.
    const requestDir = path.join(home, '.shelly/agents/action-approvals');
    expect(fs.existsSync(requestDir) ? fs.readdirSync(requestDir) : []).toHaveLength(0);
    const date = new Date().toISOString().slice(0, 10);
    const draftFile = path.join(home, 'agent-output', date, `${date}_plan-quality.md`);
    expect(fs.existsSync(draftFile)).toBe(false);

    const logDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const runLogName = fs.readdirSync(logDir).find((name) => /^\d+\.json$/.test(name))!;
    const runLog = JSON.parse(fs.readFileSync(path.join(logDir, runLogName), 'utf8'));
    expect(runLog.status).toBe('error');
    expect(runLog.errorMessage).toContain('prompt echo or AI refusal');

    const notify = JSON.parse(fs.readFileSync(path.join(logDir, 'native-result-notification.json'), 'utf8'));
    expect(notify.status).toBe('error');
    expect(notify.preview).toContain('prompt echo or AI refusal');
  });

  it('blocks a notify dispatch when the completion is refusal boilerplate, without requesting approval', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    fixtureContent = "I'm not able to post this on your behalf.";
    (plan as any).action = { type: 'notify' };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

    const result = await runExecutor([
      executor, '--plan-file', planFile, '--home', home, '--agent-id', plan.agent.id, '--broker', broker,
    ], home);

    expect(result.status).toBe(0);
    const requestDir = path.join(home, '.shelly/agents/action-approvals');
    expect(fs.existsSync(requestDir) ? fs.readdirSync(requestDir) : []).toHaveLength(0);

    const logDir = path.join(home, `.shelly/agents/logs/${plan.agent.id}`);
    const runLogName = fs.readdirSync(logDir).find((name) => /^\d+\.json$/.test(name))!;
    const runLog = JSON.parse(fs.readFileSync(path.join(logDir, runLogName), 'utf8'));
    expect(runLog.status).toBe('error');
    expect(runLog.errorMessage).toContain('prompt echo or AI refusal');

    const notify = JSON.parse(fs.readFileSync(path.join(logDir, 'native-result-notification.json'), 'utf8'));
    expect(notify.status).toBe('error');
    expect(notify.preview).toContain('prompt echo or AI refusal');
  });

  it('still dispatches a webhook when the completion is real content (no false positive)', async () => {
    const home = makeHome();
    const { plan, planFile } = makePlan(home, port);
    fixtureContent = 'Our new feature launched today — check it out!';
    (plan as any).action = { type: 'webhook', webhookUrl: 'https://hooks.example.test/incoming' };
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

    const run = runExecutor([
      executor, '--plan-file', planFile, '--home', home, '--agent-id', plan.agent.id, '--broker', broker,
    ], home);

    // Real content still reaches the human approval request (not auto-blocked).
    for (let i = 0; i < 100; i += 1) {
      const requestDir = path.join(home, '.shelly/agents/action-approvals');
      const requests = fs.existsSync(requestDir)
        ? fs.readdirSync(requestDir).filter((name) => name.startsWith('action-') && name.endsWith('.json'))
        : [];
      if (requests.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const requestDir = path.join(home, '.shelly/agents/action-approvals');
    const requests = fs.readdirSync(requestDir).filter((name) => name.startsWith('action-') && name.endsWith('.json'));
    expect(requests).toHaveLength(1);
    const request = JSON.parse(fs.readFileSync(path.join(requestDir, requests[0]), 'utf8'));
    expect(request.actionType).toBe('webhook');

    // Decline so the run finishes cleanly without actually sending.
    const crypto = require('crypto');
    const bytes = fs.readFileSync(path.join(requestDir, requests[0]));
    const requestSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.mkdirSync(path.join(home, '.shelly/agents/action-approval-replies'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.shelly/agents/action-approval-replies', `action-${request.runId}.reply.json`),
      JSON.stringify({ runId: request.runId, decision: 'decline', by: 'test', requestSha256, ts: new Date().toISOString() }) + '\n',
    );
    const result = await run;
    expect(result.status).toBe(0);
  });
});

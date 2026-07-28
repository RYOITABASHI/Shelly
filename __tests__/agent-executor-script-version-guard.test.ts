// docs/superpowers/DEFERRED.md "AGENT_SCRIPT_VERSION/CURRENT_SCRIPT_VERSIONの
// バンプ漏れが手動運用のみで頻発している" (P2) の再発防止ガード。
//
// generateRunScript()（lib/agent-executor.ts）の出力を固定入力でスナップショット
// 保存する。もしこのスナップショットが変化した場合、それは generateRunScript()
// が生成する bash スクリプトの実際の出力が変わったことを意味する。その場合は
// 必ず次の手順を踏むこと:
//   1. lib/agent-executor.ts の AGENT_SCRIPT_VERSION と
//      modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/
//      AgentRuntime.kt の CURRENT_SCRIPT_VERSION を「両方」インクリメントする
//      （片方だけのバンプは下の「二値一致」テストで検知される）。
//   2. その後で初めて `jest -u`（`--ci` を付けずに）でスナップショットを
//      再生成する。
//
// バージョンをバンプせずにスナップショットだけを更新するのは禁止。CI は
// `--ci` 付きで実行されるため、スナップショットの陳腐化（=バンプ忘れ）は
// 自動的に失敗として検出される。
//
// このテストだけでは「バンプし忘れて平然とスナップショットも更新してしまう」
// ケースまでは機械的に防げない（スナップショット差分の検知はできても、開発者
// にバンプを強制する力は無い）。ただし、そのケースは下の「二値一致」テストの
// 対象ではない（両ファイルの数値がズレていなければ検知できない）ため、この
// ガードは主に「気づかずスナップショットが古いまま放置される」事故を防ぐ設計
// である。

import * as fs from 'node:fs';
import * as path from 'node:path';

jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { generateRunScript } from '@/lib/agent-executor';
import { Agent, ToolChoice } from '@/store/types';

// agent-executor-approval-default.test.ts と同じ最小 Agent フィクスチャ。
// 固定値のみで構成し、Math.random() 等の非決定的経路（ab-article-eval の
// promptMarker 生成など）に触れない action type ('draft') を使う。
const fixedAgent: Agent = {
  id: 'snapshot-guard-agent',
  name: 'Snapshot Guard Agent',
  description: 'fixture for AGENT_SCRIPT_VERSION regression guard',
  prompt: 'Say hello in one sentence.',
  schedule: null,
  tool: { type: 'local' } as ToolChoice,
  outputPath: '~/out/snapshot-guard.md',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  action: { type: 'draft' },
};

describe('generateRunScript() output snapshot (AGENT_SCRIPT_VERSION bump-detection guard)', () => {
  it('matches the stored snapshot for a fixed minimal agent input', () => {
    const script = generateRunScript(fixedAgent);
    expect(script).toMatchSnapshot();
  });
});

describe('AGENT_SCRIPT_VERSION (TS) and CURRENT_SCRIPT_VERSION (Kotlin) must stay in lockstep', () => {
  const agentExecutorPath = path.join(__dirname, '..', 'lib', 'agent-executor.ts');
  const agentRuntimePath = path.join(
    __dirname,
    '..',
    'modules',
    'terminal-emulator',
    'android',
    'src',
    'main',
    'java',
    'expo',
    'modules',
    'terminalemulator',
    'AgentRuntime.kt',
  );

  function extractTsVersion(): number {
    const src = fs.readFileSync(agentExecutorPath, 'utf8');
    const match = src.match(/const\s+AGENT_SCRIPT_VERSION\s*=\s*(\d+)\s*;/);
    if (!match) {
      throw new Error(
        `Could not find "const AGENT_SCRIPT_VERSION = <number>;" in ${agentExecutorPath}. ` +
          'The declaration shape may have changed — update this regex.',
      );
    }
    return Number(match[1]);
  }

  function extractKotlinVersion(): number {
    const src = fs.readFileSync(agentRuntimePath, 'utf8');
    const match = src.match(/private\s+const\s+val\s+CURRENT_SCRIPT_VERSION\s*=\s*(\d+)/);
    if (!match) {
      throw new Error(
        `Could not find "private const val CURRENT_SCRIPT_VERSION = <number>" in ${agentRuntimePath}. ` +
          'The declaration shape may have changed — update this regex.',
      );
    }
    return Number(match[1]);
  }

  it('both source files declare the exact same version number', () => {
    const tsVersion = extractTsVersion();
    const kotlinVersion = extractKotlinVersion();
    // Compare via a labeled object so a mismatch prints both values in the
    // Jest diff instead of two bare numbers.
    expect({ tsAgentExecutor: tsVersion, kotlinAgentRuntime: kotlinVersion }).toEqual({
      tsAgentExecutor: tsVersion,
      kotlinAgentRuntime: tsVersion,
    });
  });
});

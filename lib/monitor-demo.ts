/**
 * lib/monitor-demo.ts — built-in DEMO playback for the MONITOR pane.
 *
 * A fixed, time-driven script (sample data, not a real run and not real
 * pricing): two scouts run in parallel, hand off to an editor that spawns a
 * fact-check sub-agent, then an archivist asks for the user's ok in plain
 * chat before "writing" to Obsidian. The user answers by typing ok / no.
 *
 * Pure: snapshot(t, inputs) replays the script from zero every call, so the
 * same (t, inputs) always yields the same state.
 */
import type {
  MonitorAgentDef,
  MonitorAgentSnapshot,
  MonitorAgentState,
  MonitorChatLine,
  MonitorInput,
  MonitorSnapshot,
  MonitorSource,
  MonitorText,
} from './monitor-source';
import { USD_TO_YEN } from './monitor-source';
import type { MonitorTeam } from './monitor-team';

export const DEMO_AGENTS: readonly MonitorAgentDef[] = [
  { id: 'ch1', channel: 'CH-01', name: 'ARXIV SCOUT', kind: 'API', provider: 'perplexity', providerName: 'Perplexity', model: 'sonar', operator: 1 },
  { id: 'ch2', channel: 'CH-02', name: 'HF SCOUT', kind: 'API', provider: 'gemini-api', providerName: 'Gemini API', model: '2.5 Flash', operator: 2 },
  { id: 'ch3', channel: 'CH-03', name: 'EDITOR', kind: 'LOCAL', provider: 'local', providerName: 'Local LLM', model: 'Qwen3.5-2B · on-device', operator: 3 },
  { id: 'ch3a', channel: 'CH-03A', name: 'FACT-CHECK', kind: 'API', provider: 'perplexity', providerName: 'Perplexity', model: 'sonar-pro', parentId: 'ch3', operator: 4 },
  { id: 'ch4', channel: 'CH-04', name: 'ARCHIVIST', kind: 'CLI', provider: 'codex-cli', providerName: 'Codex CLI', model: 'ChatGPT plan', operator: 5 },
];

export const DEMO_TEAM: MonitorTeam = {
  title: 'Daily AI paper digest → Obsidian',
  schedule: 'daily 7:00',
  // Sample budget cap: ¥20 per run (shown in the viewer's currency).
  capUsd: 20 / USD_TO_YEN,
  destination: { label: 'OBSIDIAN', path: '20_Literature/AI_Papers/{date}/' },
  columns: [
    [
      { id: 'ch1', name: 'ARXIV SCOUT', role: 'collect new papers from arXiv', provider: 'perplexity', askBeforeWrite: false },
      { id: 'ch2', name: 'HF SCOUT', role: 'collect new papers from Hugging Face', provider: 'gemini-api', askBeforeWrite: false },
    ],
    [{ id: 'ch3', name: 'EDITOR', role: 'pick 3 and summarize', provider: 'local', askBeforeWrite: false }],
    [{ id: 'ch4', name: 'ARCHIVIST', role: 'save to Obsidian AI_Papers/', provider: 'codex-cli', askBeforeWrite: true }],
  ],
  subAgents: [
    { id: 'ch3a', parentId: 'ch3', name: 'FACT-CHECK', role: 'check every claim has a source', provider: 'perplexity', askBeforeWrite: false },
  ],
};

type EventKind = 'state' | 'wait' | 'log' | 'note' | 'approval' | 'chat' | 'complete';

/** [time (s), agent | null, kind, value, tokens, usd]. For 'wait'/'note'/
 *  'chat'/'complete' the value is an i18n key suffix under monitor.demo. */
type Row = [number, string | null, EventKind, string, number?, number?];

const TL: Row[] = [
  [0, null, 'chat', 'chat.start'],
  [0, 'ch1', 'state', 'RUNNING'], [0.3, 'ch1', 'log', 'query arXiv cs.AI, last 24h', 420, 0.0011],
  [0, 'ch2', 'state', 'RUNNING'], [0.4, 'ch2', 'log', 'GET hf.co/papers?date={date}', 0, 0],
  [0, 'ch3', 'wait', 'note.wait_scouts'], [0, 'ch4', 'wait', 'note.wait_editor'], [0, 'ch3a', 'wait', 'note.sub_standby'],
  [1.4, 'ch2', 'log', '429 rate limited · retry 1/2', 0, 0], [1.6, 'ch1', 'log', '41 results', 1900, 0.0024],
  [2.6, 'ch2', 'log', '200 OK · 28 papers', 0, 0], [3.2, 'ch1', 'log', 'rank by novelty + citations', 1600, 0.0021],
  [4.0, 'ch2', 'log', 'classify 28 abstracts', 5200, 0.0019], [5.2, 'ch1', 'log', 'keep 6 candidates', 900, 0.0016],
  [5.8, 'ch2', 'log', 'drop 4 already on arXiv list', 2100, 0.0012], [7.4, 'ch1', 'log', 'hand off 6 items -> CH-03', 300, 0.001], [7.6, 'ch1', 'state', 'DONE'],
  [8.8, 'ch2', 'log', 'hand off 5 items -> CH-03', 400, 0.0006], [9.0, 'ch2', 'state', 'DONE'],
  [9.1, null, 'chat', 'chat.handoff_editor'],
  [9.3, 'ch3', 'state', 'RUNNING'], [9.5, 'ch3', 'log', 'merge 11 -> 9 unique papers', 2400, 0],
  [11.2, 'ch3', 'log', 'pick 3 notable', 3100, 0], [12.8, 'ch3', 'log', 'draft 3 summaries (EN)', 4600, 0],
  [14.2, 'ch3', 'log', 'spawn sub-agent CH-03A: check claims', 200, 0], [14.3, 'ch3', 'state', 'WAITING'], [14.3, 'ch3', 'note', 'note.wait_sub'],
  [14.3, null, 'chat', 'chat.sub_spawned'],
  [14.5, 'ch3a', 'state', 'RUNNING'], [14.7, 'ch3a', 'log', 'check 6 claims in 3 drafts', 1200, 0.0042],
  [16.2, 'ch3a', 'log', '5/6 have a source', 2300, 0.0071], [17.6, 'ch3a', 'log', 'claim #4: no source -> flag', 1100, 0.0038],
  [19.0, 'ch3a', 'log', 'return report -> CH-03', 300, 0.0012], [19.2, 'ch3a', 'state', 'DONE'],
  [19.3, null, 'chat', 'chat.sub_report'],
  [19.4, 'ch3', 'state', 'RUNNING'], [19.6, 'ch3', 'log', 'drop unsourced claim #4', 900, 0], [21.0, 'ch3', 'log', 'attach citations to 3 summaries', 2200, 0],
  [22.4, 'ch3', 'log', 'hand off 3 notes -> CH-04', 300, 0], [22.6, 'ch3', 'state', 'DONE'],
  [22.7, null, 'chat', 'chat.handoff_archivist'],
  [22.8, 'ch4', 'state', 'RUNNING'], [23.0, 'ch4', 'log', 'target 20_Literature/AI_Papers/{date}/', 1800, 0],
  [24.2, 'ch4', 'log', 'prepare 3 files', 2600, 0], [25.2, 'ch4', 'approval', ''],
];

const POST_OK: Row[] = [
  [0.4, 'ch4', 'state', 'RUNNING'], [0.5, 'ch4', 'log', 'write {date}-01.md', 700, 0], [1.2, 'ch4', 'log', 'write {date}-02.md', 650, 0],
  [1.9, 'ch4', 'log', 'write {date}-03.md', 690, 0], [2.6, 'ch4', 'log', 'append ## Sources (7 links)', 400, 0], [3.2, 'ch4', 'state', 'DONE'],
  [3.3, null, 'complete', 'chat.complete'],
];

const POST_NO: Row[] = [
  [0.3, 'ch4', 'log', 'stopped by you · nothing written', 0, 0], [0.4, 'ch4', 'state', 'STOPPED'],
  [0.5, null, 'chat', 'chat.stopped'],
];

/** Time at which the archivist asks for approval. */
export const DEMO_APPROVAL_AT = 25.2;

const OK_RE = /^(ok|okay|yes|y|はい|いいよ|お願い)$/i;
const NO_RE = /^(no|n|stop|だめ|ダメ|止めて|いいえ)$/i;

export const DEMO_MAX_LINES = 9;
export const DEMO_MAX_CHAT = 6;

const TOTAL_LOGS: Record<string, number> = {};
for (const r of [...TL, ...POST_OK]) {
  if (r[2] === 'log' && r[1]) TOTAL_LOGS[r[1]] = (TOTAL_LOGS[r[1]] ?? 0) + 1;
}

export function demoTotalLogs(id: string): number {
  return TOTAL_LOGS[id] ?? 0;
}

interface DemoEvent {
  at: number;
  seq: number;
  id: string | null;
  kind: EventKind;
  val: string;
  tok: number;
  usd: number;
}

const k = (suffix: string, params?: MonitorText['params']): MonitorText => ({
  key: `monitor.demo.${suffix}`,
  ...(params ? { params } : {}),
});

/** Demo playback for a given calendar date label (YYYY-MM-DD). */
export function simulateDemo(t: number, inputs: readonly MonitorInput[], date = '2026-10-30'): MonitorSnapshot {
  const agents: Record<string, MonitorAgentSnapshot> = {};
  for (const d of DEMO_AGENTS) {
    agents[d.id] = { state: 'STANDBY', lines: [], note: null, logs: 0, totalLogs: demoTotalLogs(d.id), tokens: 0, usd: 0 };
  }
  let seq = 0;
  const toEvents = (rows: Row[], base: number): DemoEvent[] =>
    rows.map((r) => ({ at: base + r[0], seq: seq++, id: r[1], kind: r[2], val: r[3], tok: r[4] ?? 0, usd: r[5] ?? 0 }));
  let queue = toEvents(TL, 0);
  const sortQueue = () => queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
  sortQueue();

  const chat: MonitorChatLine[] = [];
  const say = (line: MonitorChatLine) => {
    chat.push(line);
    if (chat.length > DEMO_MAX_CHAT) chat.shift();
  };
  let approvalPending = false;
  let approvalAgentId: string | null = null;
  let complete = false;

  const apply = (ev: DemoEvent) => {
    const a = ev.id ? agents[ev.id] : null;
    switch (ev.kind) {
      case 'state':
        if (!a) return;
        a.state = ev.val as MonitorAgentState;
        if (ev.val !== 'WAITING') a.note = null;
        return;
      case 'wait':
        if (!a) return;
        a.state = 'STANDBY';
        a.note = k(ev.val);
        return;
      case 'log':
        if (!a) return;
        a.lines.push(ev.val.split('{date}').join(date));
        if (a.lines.length > DEMO_MAX_LINES) a.lines.shift();
        a.logs++;
        a.tokens += ev.tok;
        a.usd += ev.usd;
        return;
      case 'note':
        if (a) a.note = k(ev.val);
        return;
      case 'approval':
        if (!a || !ev.id) return;
        a.state = 'APPROVAL';
        a.note = k('note.approval');
        approvalPending = true;
        approvalAgentId = ev.id;
        say({ who: 'shelly', message: k('chat.approval_ask', { date }), ask: true });
        return;
      case 'chat':
        say({ who: 'shelly', message: k(ev.val) });
        return;
      case 'complete':
        complete = true;
        say({ who: 'shelly', message: k(ev.val) });
        return;
    }
  };

  const answer = (input: MonitorInput) => {
    const v = input.text.trim();
    if (!v) return;
    say({ who: 'you', text: v });
    if (!approvalPending) {
      say({ who: 'shelly', message: k('chat.only_ok_no') });
      return;
    }
    if (OK_RE.test(v)) {
      approvalPending = false;
      approvalAgentId = null;
      say({ who: 'shelly', message: k('chat.ok_ack') });
      queue = queue.concat(toEvents(POST_OK, input.at));
      sortQueue();
    } else if (NO_RE.test(v)) {
      approvalPending = false;
      approvalAgentId = null;
      queue = queue.concat(toEvents(POST_NO, input.at));
      sortQueue();
    } else {
      say({ who: 'shelly', message: k('chat.reply_hint'), ask: true });
    }
  };

  const pending = [...inputs].filter((i) => i.at <= t).sort((a, b) => a.at - b.at);
  let ii = 0;
  for (;;) {
    const ev = queue[0];
    const evDue = ev !== undefined && ev.at <= t;
    const input = pending[ii];
    if (!evDue && !input) break;
    // Events at or before the input's timestamp land first.
    if (evDue && (!input || ev.at <= input.at)) {
      queue.shift();
      apply(ev);
    } else if (input) {
      ii++;
      answer(input);
    }
  }

  return { t, agents, approvalPending, approvalAgentId, complete, chat };
}

export function createDemoSource(date: string): MonitorSource {
  return {
    isDemo: true,
    agents: DEMO_AGENTS,
    team: DEMO_TEAM,
    snapshot: (t, inputs) => simulateDemo(t, inputs, date),
  };
}

/** Local calendar date as YYYY-MM-DD. */
export function demoDateLabel(now: Date = new Date()): string {
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

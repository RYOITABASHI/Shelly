/* eslint-disable no-console */
/**
 * scripts/eval/local-llm-ab-eval.js
 *
 * Reproducible A/B eval for Shelly's on-device local LLM tier (llama-server,
 * OpenAI-compatible /v1/chat/completions). Built for the MiniCPM5-2B vs
 * Qwen3.5-2B comparison (2026-10-06) but model-agnostic.
 *
 * Dependency-free (Node core `http` only) so it runs under Shelly's bundled
 * Node in the in-app terminal: `node scripts/eval/local-llm-ab-eval.js ...`.
 * Do NOT chmod +x and exec it directly on device — Knox blocks shebang
 * exec from app_data_file; always invoke through `node`.
 *
 * Usage:
 *   node local-llm-ab-eval.js --base-url http://127.0.0.1:8080 \
 *     [--model <alias>] [--label <name>] [--out results.json] \
 *     [--native-tools] [--grammar] [--max-tokens 384] [--timeout-ms 180000]
 *   node local-llm-ab-eval.js --compare a.json b.json [...]
 *
 * Suites:
 *   router  — 12 Japanese intent-classification prompts modeled on Shelly's
 *             real routing surface (agent registration / control, Perplexity
 *             research, Codex code tasks, local summarize, terminal, chat).
 *   tools   — 8 tool-selection prompts answered as a JSON function call
 *             against a Shelly-shaped tool catalog (+ one "no tool" case).
 *             With --native-tools the same cases are ALSO sent as OpenAI
 *             `tools` and scored from message.tool_calls (needs a llama.cpp
 *             build with a parser for the model's tool-call format; for
 *             MiniCPM5 that is b9833+).
 *   summary — 5 short Japanese summarization prompts, scored by required
 *             key-fact recall + line-limit compliance + Japanese output.
 *
 * Decoding is greedy (temperature 0) for both models so runs are
 * reproducible; thinking is disabled via chat_template_kwargs exactly like
 * lib/local-llm.ts does in production. JSON is parsed from the raw text with
 * NO grammar constraint by default (that is what "JSON validity" measures);
 * pass --grammar to add response_format json_schema like Shelly's
 * agent_field_extraction call does.
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const boolFlags = new Set(['native-tools', 'grammar', 'compare', 'quiet', 'help']);
    if (boolFlags.has(key)) { out[key] = true; continue; }
    out[key] = argv[++i];
  }
  return out;
}

// ─── Prompt set (fixed — changing it invalidates comparisons with old runs) ──

const ROUTER_LABELS = [
  'agent_create',
  'agent_control',
  'web_research',
  'code_task',
  'summarize',
  'terminal_command',
  'chat',
];

const ROUTER_SYSTEM = `あなたはShelly（Android上のAIターミナル）の入力ルーターです。ユーザー発話を次のどれか1つのintentに分類してください。
- agent_create: 定期実行・自動実行するエージェントを新しく作る/登録する依頼
- agent_control: 既存エージェントの一時停止・再開・削除・全停止
- web_research: 最新情報やWeb上の事実を調べる依頼（Perplexity向け）
- code_task: リポジトリのコードを書く/直す/テスト/コミットする依頼（Codex向け）
- summarize: 与えられた文章を要約・整理する依頼（ローカルLLM向け）
- terminal_command: シェルコマンドの実行やファイル一覧などの端末操作
- chat: 上記以外の雑談・一般的な質問
JSONのみで答えること。形式: {"intent":"<label>"}`;

const ROUTER_CASES = [
  { id: 'r01', expect: 'agent_create', text: '毎朝8時に最新のAIニュースを集めて要約するエージェントを作って' },
  { id: 'r02', expect: 'web_research', text: '今日のNVIDIAの株価に関する最新ニュースを調べて' },
  { id: 'r03', expect: 'code_task', text: 'lib/local-llm.ts の型エラーを直してテストも通して' },
  { id: 'r04', expect: 'agent_control', text: 'ニュース収集エージェントを一時停止して' },
  { id: 'r05', expect: 'summarize', text: 'この議事録を3行でまとめて：来週のリリースはAPK 1712で確定。QAは木曜まで。翻訳の残りは田中さんが担当。' },
  { id: 'r06', expect: 'terminal_command', text: 'カレントディレクトリのファイル一覧を表示して' },
  { id: 'r07', expect: 'chat', text: 'こんにちは、今日はちょっと疲れたよ' },
  { id: 'r08', expect: 'agent_control', text: '全部のエージェントを今すぐ止めて' },
  { id: 'r09', expect: 'web_research', text: '2026年の東京の梅雨入りはいつだった？ソース付きで教えて' },
  { id: 'r10', expect: 'code_task', text: 'READMEにインストール手順のセクションを追加してコミットして' },
  { id: 'r11', expect: 'agent_create', text: '毎週金曜の夕方に週報の下書きを作っておいて' },
  { id: 'r12', expect: 'terminal_command', text: 'git status を実行して' },
];

const TOOLS = [
  { name: 'web_search', description: 'Web検索（Perplexity）', parameters: { type: 'object', properties: { query: { type: 'string' }, recency_days: { type: 'integer' } }, required: ['query'], additionalProperties: false } },
  { name: 'run_shell', description: 'シェルコマンドを実行する', parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'], additionalProperties: false } },
  { name: 'read_file', description: 'ファイルを読む', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'write_file', description: 'ファイルに書き込む', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'send_notification', description: '端末に通知を出す', parameters: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'], additionalProperties: false } },
  { name: 'schedule_agent', description: '定期実行エージェントを登録する', parameters: { type: 'object', properties: { name: { type: 'string' }, schedule: { type: 'string' }, prompt: { type: 'string' } }, required: ['name', 'schedule', 'prompt'], additionalProperties: false } },
  { name: 'summarize_text', description: '文章を要約する', parameters: { type: 'object', properties: { text: { type: 'string' }, max_lines: { type: 'integer' } }, required: ['text', 'max_lines'], additionalProperties: false } },
];

const TOOLS_SYSTEM = `あなたはShellyのサブエージェントです。ユーザー依頼に対して、次のツールから最適なものを1つ選び、引数を埋めてください。ツールが不要な場合は tool を null にしてください。
ツール定義(JSON Schema):
${TOOLS.map((t) => JSON.stringify(t)).join('\n')}
JSONのみで答えること。形式: {"tool":"<name>"|null,"arguments":{...}}`;

const has = (s, sub) => typeof s === 'string' && s.includes(sub);

const TOOL_CASES = [
  { id: 't01', expect: 'read_file', text: '~/notes/todo.md を読んで', check: (a) => a.path === '~/notes/todo.md' },
  { id: 't02', expect: 'web_search', text: '「MiniCPM5 ベンチマーク」を過去7日分でWeb検索して', check: (a) => has(a.query, 'MiniCPM5') && a.recency_days === 7 },
  { id: 't03', expect: 'run_shell', text: '/sdcard/Download の容量を du -sh で確認して', check: (a) => has(a.command, 'du -sh') && has(a.command, '/sdcard/Download') },
  { id: 't04', expect: 'send_notification', text: '「ビルド完了」というタイトルで「APK 1712 の準備ができました」と通知して', check: (a) => a.title === 'ビルド完了' && has(a.body, '1712') },
  { id: 't05', expect: 'schedule_agent', text: '毎朝7時に天気を調べて通知するエージェントを「朝の天気」という名前で登録して', check: (a) => a.name === '朝の天気' && has(String(a.schedule || ''), '7') && has(a.prompt, '天気') },
  { id: 't06', expect: 'write_file', text: 'hello.txt に「こんにちは」と書き込んで', check: (a) => a.path === 'hello.txt' && has(a.content, 'こんにちは') },
  { id: 't07', expect: null, text: 'ありがとう、助かったよ', check: () => true },
  { id: 't08', expect: 'summarize_text', text: '次の文章を2行で要約して：Shellyはローカルで動くAIターミナルで、エージェントの定期実行や通知、Web検索を組み合わせられる。', check: (a) => a.max_lines === 2 && has(a.text, 'Shelly') },
];

const SUMMARY_SYSTEM = 'あなたは日本語の要約アシスタントです。指示された行数以内で、日本語の箇条書きなしの短文で要約してください。前置きは不要です。';

const SUMMARY_CASES = [
  {
    id: 's01', maxLines: 3, keys: ['1712', '木曜', '田中'],
    text: '定例ミーティングの議事録です。来週のリリースはAPK 1712で確定しました。QAは木曜日までに完了させる必要があります。翻訳の残作業は田中さんが担当します。リリースノートの草案は佐藤さんが金曜に共有予定です。',
  },
  {
    id: 's02', maxLines: 2, keys: ['雨', '傘'],
    text: '明日の東京は朝から雨が降り、午後には一時的に強まる見込みです。最高気温は18度で、昨日より5度低くなります。外出の際は傘を忘れずに持っていきましょう。夜には雨が止む予報です。',
  },
  {
    id: 's03', maxLines: 3, keys: ['メモリ', '0.8B'],
    text: 'ローカルLLMの運用方針をまとめます。日常の下書きや軽い推論には2Bモデルを使います。分類やルーティングには0.8Bモデルを使い、応答速度を優先します。4B以上は端末のメモリを圧迫してバックグラウンドアプリが落ちるため、短時間の品質確認に限定します。',
  },
  {
    id: 's04', maxLines: 2, keys: ['返品', '30日'],
    text: 'お問い合わせありがとうございます。商品到着後30日以内であれば、未使用品に限り返品を承ります。返品送料はお客様のご負担となりますが、初期不良の場合は当社が負担いたします。返品をご希望の場合はマイページから申請してください。',
  },
  {
    id: 's05', maxLines: 3, keys: ['停止', '再開'],
    text: 'エージェント機能のアップデートについてお知らせします。今回から、サイドバーの停止ボタンで全エージェントを一括停止できるようになりました。停止中のエージェントは再開ボタンで元のスケジュールに戻ります。3回連続で失敗したエージェントは自動的に無効化されます。',
  },
];

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function postJson(baseUrl, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error(`bad JSON response: ${text.slice(0, 200)}`)); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(payload);
  });
}

// ─── Parsing / scoring helpers ────────────────────────────────────────────────

function stripThink(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^\s*<think>[\s\S]*$/, '').trim();
}

function parseJsonLoose(text) {
  const cleaned = stripThink(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return { ok: true, strict: true, value: JSON.parse(cleaned) }; } catch { /* fall through */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return { ok: true, strict: false, value: JSON.parse(cleaned.slice(start, end + 1)) }; } catch { /* fall through */ }
  }
  return { ok: false, strict: false, value: null };
}

function validateArgs(toolName, args) {
  const tool = TOOLS.find((t) => t.name === toolName);
  if (!tool || !args || typeof args !== 'object' || Array.isArray(args)) return false;
  const props = tool.parameters.properties;
  for (const req of tool.parameters.required) if (!(req in args)) return false;
  for (const [k, v] of Object.entries(args)) {
    if (!(k in props)) return false;
    const type = props[k].type;
    if (type === 'string' && typeof v !== 'string') return false;
    if (type === 'integer' && !Number.isInteger(v)) return false;
  }
  return true;
}

function japaneseRatio(text) {
  const chars = [...String(text).replace(/\s/g, '')];
  if (!chars.length) return 0;
  const jp = chars.filter((c) => /[぀-ヿ㐀-鿿ｦ-ﾟ。、「」]/.test(c)).length;
  return jp / chars.length;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function chat(opts, messages, extra) {
  const body = {
    model: opts.model,
    messages,
    temperature: 0,
    top_p: 1,
    min_p: 0, // MiniCPM5 card: llama.cpp's default min_p=0.05 causes repetition.
    max_tokens: opts.maxTokens,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
    ...extra,
  };
  const t0 = Date.now();
  const res = await postJson(opts.baseUrl, 'v1/chat/completions', body, opts.timeoutMs);
  const wallMs = Date.now() - t0;
  const msg = (res.choices && res.choices[0] && res.choices[0].message) || {};
  const timings = res.timings || {};
  const usage = res.usage || {};
  const genTokens = timings.predicted_n != null ? timings.predicted_n : usage.completion_tokens;
  return {
    content: typeof msg.content === 'string' ? msg.content : '',
    reasoning: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '',
    toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
    finish: res.choices && res.choices[0] && res.choices[0].finish_reason,
    wallMs,
    promptTokens: timings.prompt_n != null ? timings.prompt_n : usage.prompt_tokens,
    genTokens,
    promptTps: timings.prompt_per_second || null,
    genTps: timings.predicted_per_second || (genTokens && wallMs ? (genTokens * 1000) / wallMs : null),
  };
}

function schemaFormat(name, schema) {
  return { response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } } };
}

async function runCase(opts, suite, c, fn) {
  try {
    const r = await fn();
    return { suite, id: c.id, ...r };
  } catch (e) {
    return { suite, id: c.id, error: e && e.message ? e.message : String(e), jsonValid: false, correct: false };
  }
}

async function runRouter(opts) {
  const out = [];
  const extra = opts.grammar
    ? schemaFormat('router_intent', { type: 'object', properties: { intent: { type: 'string', enum: ROUTER_LABELS } }, required: ['intent'], additionalProperties: false })
    : {};
  for (const c of ROUTER_CASES) {
    out.push(await runCase(opts, 'router', c, async () => {
      const r = await chat(opts, [{ role: 'system', content: ROUTER_SYSTEM }, { role: 'user', content: c.text }], extra);
      const p = parseJsonLoose(r.content);
      const got = p.ok && p.value && typeof p.value.intent === 'string' ? p.value.intent : null;
      return { ...r, jsonValid: p.ok, jsonStrict: p.strict, got, expect: c.expect, correct: got === c.expect };
    }));
    log(opts, out[out.length - 1]);
  }
  return out;
}

async function runTools(opts) {
  const out = [];
  const extra = opts.grammar
    ? schemaFormat('tool_call', { type: 'object', properties: { tool: { type: ['string', 'null'], enum: [...TOOLS.map((t) => t.name), null] }, arguments: { type: 'object' } }, required: ['tool', 'arguments'], additionalProperties: false })
    : {};
  for (const c of TOOL_CASES) {
    out.push(await runCase(opts, 'tools', c, async () => {
      const r = await chat(opts, [{ role: 'system', content: TOOLS_SYSTEM }, { role: 'user', content: c.text }], extra);
      const p = parseJsonLoose(r.content);
      const v = p.ok && p.value && typeof p.value === 'object' ? p.value : {};
      const got = v.tool === undefined ? undefined : v.tool;
      const args = v.arguments && typeof v.arguments === 'object' ? v.arguments : {};
      const toolOk = got === c.expect;
      const argsOk = c.expect === null ? true : validateArgs(c.expect, args) && c.check(args);
      return { ...r, jsonValid: p.ok, jsonStrict: p.strict, got, expect: c.expect, toolOk, argsOk, correct: p.ok && toolOk && argsOk };
    }));
    log(opts, out[out.length - 1]);
  }
  if (opts.nativeTools) {
    const tools = TOOLS.map((t) => ({ type: 'function', function: t }));
    for (const c of TOOL_CASES) {
      out.push(await runCase(opts, 'tools_native', c, async () => {
        const r = await chat(opts, [{ role: 'system', content: 'あなたはShellyのサブエージェントです。必要ならツールを1つ呼び出してください。不要なら普通に返答してください。' }, { role: 'user', content: c.text }], { tools, tool_choice: 'auto' });
        const call = r.toolCalls[0];
        const got = call && call.function ? call.function.name : null;
        let args = {};
        let jsonValid = true;
        if (call && call.function) {
          try { args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments || {}; } catch { jsonValid = false; }
        }
        const toolOk = got === c.expect;
        const argsOk = c.expect === null ? r.toolCalls.length === 0 : jsonValid && validateArgs(c.expect, args) && c.check(args);
        return { ...r, jsonValid, got, expect: c.expect, toolOk, argsOk, correct: toolOk && argsOk };
      }));
      log(opts, out[out.length - 1]);
    }
  }
  return out;
}

async function runSummary(opts) {
  const out = [];
  for (const c of SUMMARY_CASES) {
    out.push(await runCase(opts, 'summary', c, async () => {
      const r = await chat(opts, [{ role: 'system', content: SUMMARY_SYSTEM }, { role: 'user', content: `次の文章を${c.maxLines}行以内で要約して：\n${c.text}` }]);
      const text = stripThink(r.content);
      const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
      const hit = c.keys.filter((k) => text.includes(k)).length;
      const recall = hit / c.keys.length;
      const lineOk = lines.length > 0 && lines.length <= c.maxLines;
      const jaOk = japaneseRatio(text) >= 0.5;
      const leakedThink = /<\/?think>/.test(r.content);
      return { ...r, jsonValid: null, recall, lineOk, jaOk, leakedThink, correct: recall === 1 && lineOk && jaOk && !leakedThink, sample: text.slice(0, 160) };
    }));
    log(opts, out[out.length - 1]);
  }
  return out;
}

function log(opts, row) {
  if (opts.quiet) return;
  const tag = row.error ? `ERROR ${row.error}` : `${row.correct ? 'OK ' : 'NG '} got=${JSON.stringify(row.got !== undefined ? row.got : row.sample)} ${row.wallMs}ms ${row.genTps ? row.genTps.toFixed(1) : '?'}tok/s`;
  console.error(`[${row.suite}] ${row.id} ${tag}`);
}

// ─── Aggregation / reporting ──────────────────────────────────────────────────

function mean(xs) {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function aggregate(rows) {
  const suites = [...new Set(rows.map((r) => r.suite))];
  return suites.map((suite) => {
    const rs = rows.filter((r) => r.suite === suite);
    const jsonRows = rs.filter((r) => r.jsonValid !== null && r.jsonValid !== undefined);
    return {
      suite,
      n: rs.length,
      errors: rs.filter((r) => r.error).length,
      accuracy: rs.filter((r) => r.correct).length / rs.length,
      jsonValid: jsonRows.length ? jsonRows.filter((r) => r.jsonValid).length / jsonRows.length : null,
      recall: suite === 'summary' ? mean(rs.map((r) => r.recall)) : null,
      latencyMs: mean(rs.map((r) => r.wallMs)),
      genTps: mean(rs.map((r) => r.genTps)),
      promptTps: mean(rs.map((r) => r.promptTps)),
      genTokens: mean(rs.map((r) => r.genTokens)),
    };
  });
}

const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(0)}%`);
const num = (x, d = 1) => (x === null || x === undefined ? '—' : x.toFixed(d));

function table(results) {
  const lines = [
    '| model | suite | n | accuracy | JSON valid | key recall | mean latency (ms) | gen tok/s | prompt tok/s | mean gen tokens | errors |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const res of results) {
    for (const a of res.summary) {
      lines.push(`| ${res.label} | ${a.suite} | ${a.n} | ${pct(a.accuracy)} | ${pct(a.jsonValid)} | ${pct(a.recall)} | ${num(a.latencyMs, 0)} | ${num(a.genTps)} | ${num(a.promptTps)} | ${num(a.genTokens, 0)} | ${a.errors} |`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('see header comment of scripts/eval/local-llm-ab-eval.js');
    return;
  }
  if (args.compare) {
    const results = args._.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
    console.log(table(results));
    return;
  }
  const opts = {
    baseUrl: args['base-url'] || 'http://127.0.0.1:8080',
    model: args.model || 'local',
    label: args.label || args.model || 'local',
    maxTokens: Number(args['max-tokens'] || 384),
    timeoutMs: Number(args['timeout-ms'] || 180000),
    nativeTools: !!args['native-tools'],
    grammar: !!args.grammar,
    quiet: !!args.quiet,
  };
  // Warm-up (excluded): first request pays model page-in / KV alloc cost.
  try { await chat({ ...opts, maxTokens: 8 }, [{ role: 'user', content: 'こんにちは' }]); } catch (e) {
    console.error(`warm-up failed against ${opts.baseUrl}: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  const rows = [
    ...(await runRouter(opts)),
    ...(await runTools(opts)),
    ...(await runSummary(opts)),
  ];
  const result = {
    label: opts.label,
    model: opts.model,
    baseUrl: opts.baseUrl,
    grammar: opts.grammar,
    nativeTools: opts.nativeTools,
    date: new Date().toISOString(),
    summary: aggregate(rows),
    rows,
  };
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
  console.log(table([result]));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exitCode = 1;
  });
}

module.exports = { ROUTER_CASES, TOOL_CASES, SUMMARY_CASES, TOOLS, parseJsonLoose, stripThink, validateArgs, aggregate, table };

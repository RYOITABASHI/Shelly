#!/usr/bin/env node
// Host stand-in for `bash ~/.shelly-claude-run.sh <claude args>` in the Claude
// engine tests (__tests__/claude-glibc-s4.test.ts). Speaks the subset of
// Claude Code's stream-json control protocol the driver uses: it waits for the
// user message, asks can_use_tool for each tool in FAKE_CLAUDE_TOOLS (JSON
// array of {tool_name, input}), records the answers, and ends with a `result`
// whose text lists the decisions. argv and the settings env are echoed into
// FAKE_CLAUDE_RECORD so tests can assert what the real claude would receive.
const fs = require('fs');

const tools = JSON.parse(process.env.FAKE_CLAUDE_TOOLS || '[]');
const record = process.env.FAKE_CLAUDE_RECORD;
const decisions = [];
let pending = null;
let prompt = null;
let buffer = '';

function out(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function askNext() {
  if (decisions.length >= tools.length) {
    if (process.env.FAKE_CLAUDE_ASSISTANT_TOOL && !askNext.sentTool) {
      askNext.sentTool = true;
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-x', name: process.env.FAKE_CLAUDE_ASSISTANT_TOOL, input: {} }] } });
    }
    if (record) {
      fs.writeFileSync(record, JSON.stringify({
        argv: process.argv.slice(2),
        settings: process.env.SHELLY_CLAUDE_SETTINGS_JSON || null,
        claudeCodeShell: process.env.CLAUDE_CODE_SHELL || null,
        apiKey: process.env.ANTHROPIC_API_KEY || null,
        oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || null,
        auth: process.env.SHELLY_CLAUDE_AUTH || null,
        optIn: process.env.SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED || null,
        prompt,
        decisions,
      }));
    }
    out({
      type: 'result',
      subtype: process.env.FAKE_CLAUDE_FAIL === '1' ? 'error_during_execution' : 'success',
      is_error: process.env.FAKE_CLAUDE_FAIL === '1',
      result: `decisions: ${decisions.map((d) => d.behavior).join(',')}`,
      num_turns: 1,
      total_cost_usd: 0.0123,
      usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 42 },
    });
    return;
  }
  const t = tools[decisions.length];
  pending = `req-${decisions.length + 1}`;
  out({ type: 'control_request', request_id: pending, request: { subtype: 'can_use_tool', tool_name: t.tool_name, input: t.input, tool_use_id: `tu-${decisions.length + 1}` } });
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type === 'control_request' && msg.request && msg.request.subtype === 'initialize') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    } else if (msg.type === 'user') {
      prompt = msg.message.content[0].text;
      out({ type: 'system', subtype: 'init', cwd: process.cwd(), model: 'fake', permissionMode: 'default', ...(process.env.FAKE_CLAUDE_OMIT_API_KEY_SOURCE === '1' ? {} : { apiKeySource: process.env.FAKE_CLAUDE_API_KEY_SOURCE || (process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'none') }), tools: ['Bash', 'Read'] });
      askNext();
    } else if (msg.type === 'control_response' && msg.response.request_id === pending) {
      decisions.push(msg.response.response);
      pending = null;
      askNext();
    }
  }
});
process.stdin.on('end', () => process.exit(0));

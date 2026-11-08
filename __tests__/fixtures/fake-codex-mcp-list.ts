/**
 * A fake `codex mcp list --json` for driver E2E tests. The driver's host
 * preflight runs `<codex-bin> mcp list <-c overrides…> --json`, so with
 * --codex-bin = node a file named `mcp` in --cwd runs this script.
 *
 * FAKE_MCP_SERVERS: comma-separated configured server names (default none).
 * A server is reported disabled when `-c mcp_servers.<name>.enabled=false` is
 * on the command line, like real Codex — unless FAKE_MCP_IGNORE_DISABLE=1.
 * FAKE_MCP_LIST_FAIL=1 exits non-zero; FAKE_MCP_LIST_RECORD appends each argv;
 * FAKE_MCP_HOME_RECORD appends the CODEX_HOME each listing ran with;
 * FAKE_MCP_ENV_RECORD appends the CODEX_* / OPENAI_* env names it saw.
 */
export const FAKE_CODEX_MCP_LIST = `
const fs = require('fs');
const argv = process.argv.slice(2);
if (process.env.FAKE_MCP_LIST_RECORD) fs.appendFileSync(process.env.FAKE_MCP_LIST_RECORD, JSON.stringify(argv) + '\\n');
if (process.env.FAKE_MCP_HOME_RECORD) fs.appendFileSync(process.env.FAKE_MCP_HOME_RECORD, (process.env.CODEX_HOME || '') + '\\n');
if (process.env.FAKE_MCP_ENV_RECORD) fs.appendFileSync(process.env.FAKE_MCP_ENV_RECORD, JSON.stringify(Object.keys(process.env).filter((k) => /^(CODEX_|OPENAI_)/i.test(k)).sort()) + '\\n');
if (process.env.FAKE_MCP_LIST_FAIL === '1') { process.stderr.write('boom'); process.exit(2); }
const names = (process.env.FAKE_MCP_SERVERS || '').split(',').filter(Boolean);
const ignore = process.env.FAKE_MCP_IGNORE_DISABLE === '1';
process.stdout.write(JSON.stringify(names.map((name) => ({
  name,
  enabled: ignore || !argv.includes('mcp_servers.' + name + '.enabled=false'),
  transport: { type: 'stdio', command: 'x', env: { SECRET_TOKEN: 'do-not-log' } },
}))));
`;

/**
 * A fake `codex features list` for driver E2E tests of the normal worker (the
 * driver refuses to start it unless image_generation is reported off). Like
 * real Codex, a feature is listed off when `-c features.<name>=false` is on
 * the command line. FAKE_FEATURES_IMAGEGEN forces the reported value.
 */
export const FAKE_CODEX_FEATURES_LIST = `
const argv = process.argv.slice(2);
const off = (name) => argv.includes('features.' + name + '=false');
const ig = process.env.FAKE_FEATURES_IMAGEGEN || (off('image_generation') ? 'false' : 'true');
process.stdout.write('shell_tool                               stable             true\\n');
process.stdout.write('image_generation                         stable             ' + ig + '\\n');
`;

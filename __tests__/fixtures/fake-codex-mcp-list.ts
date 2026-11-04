/**
 * A fake `codex mcp list --json` for driver E2E tests. The driver's host
 * preflight runs `<codex-bin> mcp list <-c overrides…> --json`, so with
 * --codex-bin = node a file named `mcp` in --cwd runs this script.
 *
 * FAKE_MCP_SERVERS: comma-separated configured server names (default none).
 * A server is reported disabled when `-c mcp_servers.<name>.enabled=false` is
 * on the command line, like real Codex — unless FAKE_MCP_IGNORE_DISABLE=1.
 * FAKE_MCP_LIST_FAIL=1 exits non-zero; FAKE_MCP_LIST_RECORD appends each argv;
 * FAKE_MCP_HOME_RECORD appends the CODEX_HOME each listing ran with.
 */
export const FAKE_CODEX_MCP_LIST = `
const fs = require('fs');
const argv = process.argv.slice(2);
if (process.env.FAKE_MCP_LIST_RECORD) fs.appendFileSync(process.env.FAKE_MCP_LIST_RECORD, JSON.stringify(argv) + '\\n');
if (process.env.FAKE_MCP_HOME_RECORD) fs.appendFileSync(process.env.FAKE_MCP_HOME_RECORD, (process.env.CODEX_HOME || '') + '\\n');
if (process.env.FAKE_MCP_LIST_FAIL === '1') { process.stderr.write('boom'); process.exit(2); }
const names = (process.env.FAKE_MCP_SERVERS || '').split(',').filter(Boolean);
const ignore = process.env.FAKE_MCP_IGNORE_DISABLE === '1';
process.stdout.write(JSON.stringify(names.map((name) => ({
  name,
  enabled: ignore || !argv.includes('mcp_servers.' + name + '.enabled=false'),
  transport: { type: 'stdio', command: 'x', env: { SECRET_TOKEN: 'do-not-log' } },
}))));
`;

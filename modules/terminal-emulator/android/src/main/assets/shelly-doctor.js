#!/usr/bin/env node
/**
 * Shelly doctor: read-only diagnostics for bundled and managed CLI runtimes.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = os.homedir();
const LIB = process.env.SHELLY_LIB_DIR || '';
const JSON_MODE = process.argv.includes('--json');
const SDCARD_DOWNLOAD = '/sdcard/Download';
const SECRET_ENV_NAMES = [
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_AUTH_TOKEN',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'PERPLEXITY_API_KEY',
];

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function statInfo(p) {
  try {
    const s = fs.statSync(p);
    return {
      exists: true,
      size: s.size,
      mode: `0${(s.mode & 0o777).toString(8)}`,
      mtime: s.mtime.toISOString(),
    };
  } catch {
    return { exists: false };
  }
}

function modeIsPrivate(info) {
  if (!info?.exists || !info.mode) return null;
  const mode = Number.parseInt(info.mode, 8);
  if (!Number.isFinite(mode)) return false;
  return (mode & 0o077) === 0;
}

function securityFile(p, { shouldBePrivate = false } = {}) {
  const info = statInfo(p);
  return {
    path: p,
    ...info,
    should_be_private: shouldBePrivate,
    private_mode: shouldBePrivate ? modeIsPrivate(info) : null,
  };
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function readlink(p) {
  try { return fs.readlinkSync(p); } catch { return ''; }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function run(cmd, args, env = {}) {
  const merged = { ...process.env, ...env };
  delete merged.LD_PRELOAD;
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000, env: merged });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

function linker(args) {
  return run('/system/bin/linker64', args);
}

function claudeVersion(binary) {
  if (!LIB || !exists(binary)) return { ok: false, status: null, stdout: '', stderr: 'missing binary' };
  return linker([
    path.join(LIB, 'shelly_musl_exec'),
    path.join(LIB, 'ld-musl-aarch64.so.1'),
    binary,
    '--version',
  ]);
}

function claudeExtractedVersion(script) {
  if (!LIB || !exists(script)) return { ok: false, status: null, stdout: '', stderr: 'missing script' };
  return run('/system/bin/linker64', [
    path.join(LIB, 'node'),
    script,
    '--version',
  ], {
    USE_BUILTIN_RIPGREP: '0',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_INSTALLATION_CHECKS: '1',
    TMPDIR: path.join(HOME, '.tmp'),
    CLAUDE_CODE_TMPDIR: path.join(HOME, '.claude-tmp'),
    CLAUDE_TMPDIR: path.join(HOME, '.claude-tmp'),
    SHELLY_SILENT_CLI_TIER: '1',
  });
}

function codexVersion(binary) {
  if (!exists(binary)) return { ok: false, status: null, stdout: '', stderr: 'missing binary' };
  return linker([binary, '--version']);
}

function nodeScriptVersion(script, args = ['--version']) {
  if (!LIB || !exists(script)) return { ok: false, status: null, stdout: '', stderr: 'missing script' };
  return linker([path.join(LIB, 'node'), script, ...args]);
}

function geminiVersion(script) {
  if (!LIB || !exists(script)) return { ok: false, status: null, stdout: '', stderr: 'missing script' };
  const probe = run('/system/bin/linker64', [
    path.join(LIB, 'node'),
    '--max-old-space-size=5557',
    script,
    '--version',
  ], {
    GEMINI_CLI_NO_RELAUNCH: 'true',
  });
  if (probe.ok) return probe;

  // The interactive `gemini()` bash function is the source of truth for
  // execution. On some Android/linker combinations, a direct doctor-side Node
  // probe can still trip over gemini-cli's heap relaunch path and report
  // `expected absolute path: "--max-old-space-size=5557"` even though
  // `gemini --version` works from the user's shell. Avoid a false WARN by
  // falling back to package metadata for diagnostics.
  const pkg = readJson(path.join(path.dirname(path.dirname(script)), 'package.json'));
  if (pkg?.version) {
    return {
      ok: true,
      status: 0,
      stdout: `${pkg.version} (package metadata; direct probe failed: ${probe.stderr || probe.stdout})`,
      stderr: '',
    };
  }
  return probe;
}

function authJsonSummary(p) {
  const info = statInfo(p);
  if (!info.exists) return { ...info, parse: 'missing' };
  try {
    const parsed = JSON.parse(readText(p));
    return {
      ...info,
      parse: 'ok',
      auth_mode: parsed.auth_mode || null,
      has_tokens: Boolean(parsed.tokens),
      has_refresh_token: Boolean(parsed.tokens?.refresh_token),
      last_refresh: parsed.last_refresh || null,
    };
  } catch (e) {
    return { ...info, parse: `invalid json: ${e.message}` };
  }
}

function collect() {
  const runtimeClaude = path.join(HOME, '.shelly-runtime/claude/current/claude');
  const runtimeClaudeExtracted = path.join(HOME, '.shelly-runtime/claude-extracted/current/node_modules/@anthropic-ai/claude-code-extracted/cli.js');
  const apkClaudeExtracted = path.join(LIB, 'node_modules/@anthropic-ai/claude-code-extracted/cli.js');
  const runtimeCodexExec = path.join(HOME, '.shelly-runtime/codex/current/codex_exec');
  const runtimeCodexTui = path.join(HOME, '.shelly-runtime/codex/current/codex_tui');
  const apkClaude = path.join(LIB, 'claude');
  const apkCodexExec = path.join(LIB, 'codex_exec');
  const apkCodexTui = path.join(LIB, 'codex_tui');

  const security = {
    download_credentials: [
      securityFile(path.join(SDCARD_DOWNLOAD, 'shelly-claude-root.json')),
      securityFile(path.join(SDCARD_DOWNLOAD, 'termux-claude-dir.tar')),
      securityFile(path.join(SDCARD_DOWNLOAD, 'termux-gemini-dir.tar')),
    ],
    private_files: [
      securityFile(path.join(HOME, '.claude.json'), { shouldBePrivate: true }),
      securityFile(path.join(HOME, '.claude/.credentials.json'), { shouldBePrivate: true }),
      securityFile(path.join(HOME, '.codex/auth.json'), { shouldBePrivate: true }),
      securityFile(path.join(HOME, '.shelly/agents/.env'), { shouldBePrivate: true }),
    ],
    env_keys_present: SECRET_ENV_NAMES.filter((name) => Boolean(process.env[name])),
  };

  return {
    bashrc_version: readText(path.join(HOME, '.bashrc_version')).trim() || null,
    lib_dir: LIB || null,
    runtime: {
      update_log: statInfo(path.join(HOME, '.shelly-runtime/update.log')),
      last_update_marker: readText(path.join(HOME, '.shelly-runtime/.last_update')).trim() || null,
    },
    claude: {
      runtime_current: readlink(path.join(HOME, '.shelly-runtime/claude/current')) || null,
      extracted_current: readlink(path.join(HOME, '.shelly-runtime/claude-extracted/current')) || null,
      extracted_binary: statInfo(runtimeClaudeExtracted),
      extracted_version: exists(runtimeClaudeExtracted)
        ? claudeExtractedVersion(runtimeClaudeExtracted)
        : claudeExtractedVersion(apkClaudeExtracted),
      runtime_binary: statInfo(runtimeClaude),
      runtime_version: claudeVersion(runtimeClaude),
      apk_binary: statInfo(apkClaude),
      apk_version: claudeVersion(apkClaude),
      legacy_version: nodeScriptVersion(path.join(LIB, 'node_modules/@anthropic-ai/claude-code/cli.js')),
      auth_root: statInfo(path.join(HOME, '.claude.json')),
      auth_credentials: statInfo(path.join(HOME, '.claude/.credentials.json')),
    },
    codex: {
      runtime_current: readlink(path.join(HOME, '.shelly-runtime/codex/current')) || null,
      runtime_exec: statInfo(runtimeCodexExec),
      runtime_tui: statInfo(runtimeCodexTui),
      runtime_version: codexVersion(runtimeCodexExec),
      apk_exec: statInfo(apkCodexExec),
      apk_tui: statInfo(apkCodexTui),
      apk_version: codexVersion(apkCodexExec),
      auth: authJsonSummary(path.join(HOME, '.codex/auth.json')),
    },
    gemini: {
      bundle: statInfo(path.join(HOME, '.shelly-cli/node_modules/@google/gemini-cli/bundle/gemini.js')),
      apk_bundle: statInfo(path.join(LIB, 'node_modules/@google/gemini-cli/bundle/gemini.js')),
      version: exists(path.join(HOME, '.shelly-cli/node_modules/@google/gemini-cli/bundle/gemini.js'))
        ? geminiVersion(path.join(HOME, '.shelly-cli/node_modules/@google/gemini-cli/bundle/gemini.js'))
        : geminiVersion(path.join(LIB, 'node_modules/@google/gemini-cli/bundle/gemini.js')),
    },
    security,
  };
}

function mark(ok) {
  return ok ? 'OK' : 'WARN';
}

function line(label, value) {
  process.stdout.write(`${label.padEnd(24)} ${value}\n`);
}

function printHuman(d) {
  line('bashrc', d.bashrc_version || 'missing');
  line('runtime log', d.runtime.update_log.exists ? d.runtime.update_log.mtime : 'missing');
  process.stdout.write('\n');

  line('claude extracted', `${mark(d.claude.extracted_version.ok)} ${d.claude.extracted_version.stdout || d.claude.extracted_version.stderr}`);
  line('claude musl runtime', `${mark(d.claude.runtime_version.ok)} ${d.claude.runtime_version.stdout || d.claude.runtime_version.stderr}`);
  line('claude apk', `${mark(d.claude.apk_version.ok)} ${d.claude.apk_version.stdout || d.claude.apk_version.stderr}`);
  line('claude legacy', `${mark(d.claude.legacy_version.ok)} ${d.claude.legacy_version.stdout || d.claude.legacy_version.stderr}`);
  line('claude auth root', d.claude.auth_root.exists ? `${d.claude.auth_root.mtime} ${d.claude.auth_root.mode}` : 'missing');
  line('claude credentials', d.claude.auth_credentials.exists ? `${d.claude.auth_credentials.mtime} ${d.claude.auth_credentials.mode}` : 'missing');
  process.stdout.write('\n');

  line('codex runtime', `${mark(d.codex.runtime_version.ok)} ${d.codex.runtime_version.stdout || d.codex.runtime_version.stderr}`);
  line('codex apk', `${mark(d.codex.apk_version.ok)} ${d.codex.apk_version.stdout || d.codex.apk_version.stderr}`);
  line('codex auth', d.codex.auth.exists ? `${d.codex.auth.parse} mode=${d.codex.auth.auth_mode || 'unknown'} refresh=${d.codex.auth.has_refresh_token}` : 'missing');
  process.stdout.write('\n');

  line('gemini', `${mark(d.gemini.version.ok)} ${d.gemini.version.stdout || d.gemini.version.stderr}`);
  process.stdout.write('\n');

  const leftover = d.security.download_credentials.filter((f) => f.exists);
  line('download credentials', leftover.length > 0
    ? `WARN ${leftover.map((f) => path.basename(f.path)).join(', ')} still in /sdcard/Download`
    : 'OK none');
  for (const f of d.security.private_files) {
    if (!f.exists) continue;
    const labelName = path.basename(f.path) === '.env' ? 'agent env' : path.basename(f.path);
    line(labelName, `${f.private_mode ? 'OK' : 'WARN'} ${f.mode}${f.private_mode ? '' : ' should be 0600/0700-private'}`);
  }
  line('api env vars', d.security.env_keys_present.length > 0
    ? `WARN ${d.security.env_keys_present.join(', ')} present in process env`
    : 'OK none');
  process.stdout.write('\n');
  process.stdout.write('Use --json for machine-readable output.\n');
}

const data = collect();
if (JSON_MODE) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
} else {
  printHuman(data);
}

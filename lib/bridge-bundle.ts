/**
 * Bridge server bundle — auto-generated from ~/shelly-bridge/server.js
 * DO NOT EDIT MANUALLY — run: node scripts/sync-bridge-bundle.js
 */

export const BRIDGE_SERVER_VERSION = '4.0.0';

export const BRIDGE_SERVER_JS = `#!/usr/bin/env node
/**
 * Shelly Bridge Server v4.0.0
 * WebSocket bridge between Shelly app and Termux shell.
 * Run: node ~/shelly-bridge/server.js
 */

const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = parseInt(process.env.SHELLY_PORT || '8765', 10);
const DANGEROUS_CHECK = !process.argv.includes('--no-dangerous-check');
const USE_PTY = !process.argv.includes('--no-pty');

// Try to load node-pty for interactive commands (vim, node REPL, etc.)
let pty = null;
if (USE_PTY) {
  try {
    pty = require('node-pty');
    console.log('[shelly-bridge] node-pty loaded — PTY mode available');
  } catch (_) {
    console.log('[shelly-bridge] node-pty not installed — using pipe mode (install: npm i -g node-pty)');
  }
}

let currentCwd = os.homedir();
let activeProcess = null;
let activeRequestId = null;
let activeWs = null;
let cancelPending = false;
let sigkillTimer = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function send(ws, obj) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
  }
}

function clearSigkillTimer() {
  if (sigkillTimer) {
    clearTimeout(sigkillTimer);
    sigkillTimer = null;
  }
}

// NOTE: This list is intentionally less strict than ai-tool-agent.ts BLOCKED_AGENT_PATTERNS.
// Bridge serves user-typed commands from the terminal UI, so $(), backticks, ssh, eval etc.
// are legitimate user operations. Agent-generated commands have stricter filtering in
// ai-tool-agent.ts (Layer 1). This is Layer 2 — catching universally destructive patterns.
const DANGEROUS_PATTERNS = [
  /rm\\s+-[^\\s]*r[^\\s]*f/i,             // rm -rf (any target)
  /rm\\s+-[^\\s]*f[^\\s]*r/i,             // rm -fr (any target)
  /mkfs\\./i,                              // format filesystem
  /dd\\s+.*of=\\/dev\\//i,                // dd to device
  /:\\(\\)\\{.*:\\|.*&.*\\}/,              // fork bomb
  />\\s*\\/dev\\/sd/,                      // overwrite block device
  /curl\\s.*\\|.*(?:bash|sh)/i,           // curl | bash
  /wget\\s.*-O\\s/i,                      // wget -O (file overwrite)
  /\\|\\s*(?:bash|sh|zsh)\\b/i,           // pipe to shell
  />\\s*~\\/\\.(?:bashrc|profile|zshrc)/i, // overwrite shell config
];

function isDangerous(cmd) {
  if (!DANGEROUS_CHECK) return false;
  return DANGEROUS_PATTERNS.some((p) => p.test(cmd));
}

// ── cd handler ───────────────────────────────────────────────────────────────

function handleCd(ws, requestId, target) {
  const resolved = path.resolve(currentCwd, target || os.homedir());
  try {
    if (!fs.existsSync(resolved)) {
      send(ws, { type: 'stderr', requestId, data: \`cd: \${resolved}: No such file or directory\\n\` });
      send(ws, { type: 'exit', requestId, code: 1, cwd: currentCwd });
      return;
    }
    if (!fs.statSync(resolved).isDirectory()) {
      send(ws, { type: 'stderr', requestId, data: \`cd: \${resolved}: Not a directory\\n\` });
      send(ws, { type: 'exit', requestId, code: 1, cwd: currentCwd });
      return;
    }
    currentCwd = resolved;
    send(ws, { type: 'exit', requestId, code: 0, cwd: currentCwd });
  } catch (err) {
    send(ws, { type: 'stderr', requestId, data: \`cd: \${err.message}\\n\` });
    send(ws, { type: 'exit', requestId, code: 1, cwd: currentCwd });
  }
}

// ── Run handler ──────────────────────────────────────────────────────────────

function handleRun(ws, requestId, command, opts) {
  if (!requestId || !command) {
    send(ws, { type: 'error', requestId, message: 'requestId and command are required' });
    return;
  }

  // Single-process model: only one command runs at a time per bridge instance.
  // This prevents resource contention on mobile devices. Concurrent exec requests
  // from multiple tabs are queued client-side (use-termux-bridge.ts processQueue).
  if (activeProcess) {
    send(ws, { type: 'error', requestId, message: 'Another command is already running.' });
    return;
  }

  if (isDangerous(command)) {
    send(ws, {
      type: 'stderr',
      requestId,
      data: \`[BLOCKED] Dangerous command pattern detected: \${command}\\n\`,
    });
    send(ws, { type: 'exit', requestId, code: 1, cwd: currentCwd });
    return;
  }

  const execCwd = (opts && opts.cwd) ? path.resolve(currentCwd, opts.cwd) : currentCwd;
  if (!fs.existsSync(execCwd)) {
    send(ws, { type: 'error', requestId, message: \`Working directory does not exist: \${execCwd}\` });
    send(ws, { type: 'exit', requestId, code: 1, cwd: currentCwd });
    return;
  }
  const execEnv = opts && opts.env ? { ...process.env, ...opts.env, TERM: 'xterm-256color' } : { ...process.env, TERM: 'xterm-256color' };
  // Remove Claude Code nesting guard — bridge spawns independent processes, not nested sessions
  delete execEnv.CLAUDECODE;
  delete execEnv.CLAUDE_CODE_SESSION;

  console.log(\`[shelly-bridge] [\${requestId}] RUN: \${command} (cwd: \${execCwd})\`);

  // Handle cd specially
  const cdMatch = command.trim().match(/^cd\\s*(.*)?$/);
  if (cdMatch) {
    handleCd(ws, requestId, cdMatch[1]?.trim() || os.homedir());
    return;
  }

  if (pty) {
    // PTY mode — supports interactive programs (vim, node REPL, python, claude, etc.)
    const proc = pty.spawn('bash', ['-c', command], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: execCwd,
      env: execEnv,
    });

    activeProcess = proc;
    activeRequestId = requestId;
    activeWs = ws;
    cancelPending = false;

    proc.onData((data) => {
      send(ws, { type: 'stdout', requestId, data });
    });

    proc.onExit(({ exitCode, signal }) => {
      clearSigkillTimer();
      const wasCancelled = cancelPending || signal === 2 || exitCode === 130;
      const code = wasCancelled ? 130 : (exitCode ?? 0);

      console.log(\`[shelly-bridge] [\${requestId}] EXIT(pty): code=\${exitCode} signal=\${signal} cancelled=\${wasCancelled}\`);

      activeProcess = null;
      activeRequestId = null;
      activeWs = null;
      cancelPending = false;

      if (wasCancelled) {
        send(ws, { type: 'stderr', requestId, data: '^C\\n' });
        send(ws, { type: 'cancelled', requestId, cwd: currentCwd });
      } else {
        send(ws, { type: 'exit', requestId, code, cwd: currentCwd });
      }
    });
  } else {
    // Pipe mode — fallback when node-pty is not available
    const proc = spawn('bash', ['-c', command], {
      cwd: execCwd,
      env: { ...execEnv, COLUMNS: '120', LINES: '40' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    activeProcess = proc;
    activeRequestId = requestId;
    activeWs = ws;
    cancelPending = false;

    proc.stdout.on('data', (data) => {
      send(ws, { type: 'stdout', requestId, data: data.toString() });
    });

    proc.stderr.on('data', (data) => {
      send(ws, { type: 'stderr', requestId, data: data.toString() });
    });

    proc.on('close', (code, signal) => {
      clearSigkillTimer();

      const wasCancelled = cancelPending || signal === 'SIGINT' || code === 130;
      const exitCode = wasCancelled ? 130 : (code ?? 0);

      console.log(\`[shelly-bridge] [\${requestId}] EXIT: code=\${code} signal=\${signal} cancelled=\${wasCancelled}\`);

      activeProcess = null;
      activeRequestId = null;
      activeWs = null;
      cancelPending = false;

      if (wasCancelled) {
        send(ws, { type: 'stderr', requestId, data: '^C\\n' });
        send(ws, { type: 'cancelled', requestId, cwd: currentCwd });
      } else {
        send(ws, { type: 'exit', requestId, code: exitCode, cwd: currentCwd });
      }
    });

    proc.on('error', (err) => {
      console.error(\`[shelly-bridge] [\${requestId}] ERROR: \${err.message}\`);
      activeProcess = null;
      activeRequestId = null;
      activeWs = null;
      send(ws, { type: 'error', requestId, message: err.message });
      send(ws, { type: 'exit', requestId, code: 1, cwd: currentCwd });
    });
  }
}

// ── Stdin handler ───────────────────────────────────────────────────────

function handleStdin(ws, requestId, data) {
  if (!requestId || data == null) {
    send(ws, { type: 'error', requestId, message: 'requestId and data are required' });
    return;
  }
  if (!activeProcess || activeRequestId !== requestId) {
    send(ws, { type: 'error', requestId, message: 'No matching process to send stdin' });
    return;
  }
  try {
    if (pty && typeof activeProcess.write === 'function') {
      // PTY mode — write directly to pty
      activeProcess.write(data);
    } else {
      // Pipe mode — write to stdin pipe
      if (!activeProcess.stdin || activeProcess.stdin.destroyed) {
        send(ws, { type: 'error', requestId, message: 'Process stdin is not writable' });
        return;
      }
      // Check for EOF (Ctrl+D)
      if (data === '\\x04') {
        activeProcess.stdin.end();
      } else {
        activeProcess.stdin.write(data);
      }
    }
  } catch (err) {
    send(ws, { type: 'error', requestId, message: \`stdin write error: \${err.message}\` });
  }
}

// ── Cancel handler ───────────────────────────────────────────────────────────

function handleCancel(ws, requestId) {
  if (!activeProcess || activeRequestId !== requestId) {
    send(ws, { type: 'error', requestId, message: 'No matching process to cancel' });
    return;
  }

  console.log(\`[shelly-bridge] [\${requestId}] CANCEL requested\`);
  cancelPending = true;

  // Try SIGINT first
  try {
    activeProcess.kill('SIGINT');
  } catch (_) {}

  // Force SIGKILL after 5s if still alive
  sigkillTimer = setTimeout(() => {
    if (activeProcess) {
      console.log(\`[shelly-bridge] [\${requestId}] Force SIGKILL\`);
      try {
        activeProcess.kill('SIGKILL');
      } catch (_) {}
    }
  }, 5000);
}

// ── createProject handler ────────────────────────────────────────────────────

function handleCreateProject(ws, requestId, projectPath, files) {
  if (!requestId || !projectPath || !Array.isArray(files)) {
    send(ws, { type: 'error', requestId, message: 'requestId, projectPath, and files are required' });
    return;
  }

  const resolved = path.resolve(currentCwd, projectPath);

  // Home directory restriction
  const homeDir = os.homedir();
  if (!resolved.startsWith(homeDir + path.sep) && resolved !== homeDir) {
    send(ws, { type: 'error', requestId, message: \`Create blocked: path outside home directory: \${resolved}\` });
    return;
  }

  console.log(\`[shelly-bridge] [\${requestId}] CREATE_PROJECT: \${resolved} (\${files.length} files)\`);

  try {
    fs.mkdirSync(resolved, { recursive: true });

    let written = 0;
    for (const file of files) {
      if (!file.path || file.content == null) continue;
      const filePath = path.resolve(resolved, file.path);
      // Path traversal prevention
      if (!filePath.startsWith(resolved + path.sep) && filePath !== resolved) {
        send(ws, { type: 'error', requestId, message: \`Path traversal blocked: \${file.path}\` });
        return;
      }
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, file.content, 'utf8');
      written++;
      send(ws, { type: 'progress', requestId, message: \`Writing \${file.path}\`, current: written, total: files.length });
    }

    send(ws, { type: 'projectCreated', requestId, projectPath: resolved, filesWritten: written });
  } catch (err) {
    send(ws, { type: 'error', requestId, message: err.message });
  }
}

// ── writeFile handler ────────────────────────────────────────────────────────

function handleWriteFile(ws, requestId, filePath, content, encoding) {
  if (!requestId || !filePath || content == null) {
    send(ws, { type: 'error', requestId, message: 'requestId, filePath, and content are required' });
    return;
  }

  const resolved = path.resolve(currentCwd, filePath);
  // Restrict to home directory to prevent arbitrary file writes
  const homeDir = os.homedir();
  if (!resolved.startsWith(homeDir + path.sep) && resolved !== homeDir) {
    send(ws, { type: 'error', requestId, message: \`Write blocked: path outside home directory: \${resolved}\` });
    return;
  }
  console.log(\`[shelly-bridge] [\${requestId}] WRITE_FILE: \${resolved}\`);

  try {
    const dir = path.dirname(resolved);
    fs.mkdirSync(dir, { recursive: true });
    const validEncodings = ['utf8', 'utf-8', 'ascii', 'base64', 'hex', 'latin1', 'binary'];
    const enc = validEncodings.includes(encoding) ? encoding : 'utf8';
    fs.writeFileSync(resolved, content, enc);
    send(ws, { type: 'fileWritten', requestId, filePath: resolved });
  } catch (err) {
    send(ws, { type: 'error', requestId, message: err.message });
  }
}

// ── readFile handler ────────────────────────────────────────────────────────

function handleReadFile(ws, requestId, filePath, opts) {
  if (!requestId || !filePath) {
    send(ws, { type: 'error', requestId, message: 'requestId and filePath are required' });
    return;
  }

  const resolved = path.resolve(currentCwd, filePath);

  // Home directory restriction
  const homeDir = os.homedir();
  if (!resolved.startsWith(homeDir + path.sep) && resolved !== homeDir) {
    send(ws, { type: 'error', requestId, message: \`Read blocked: path outside home directory: \${resolved}\` });
    return;
  }

  console.log(\`[shelly-bridge] [\${requestId}] READ_FILE: \${resolved}\`);

  try {
    if (!fs.existsSync(resolved)) {
      send(ws, { type: 'error', requestId, message: \`No such file: \${resolved}\` });
      return;
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      send(ws, { type: 'error', requestId, message: \`Is a directory: \${resolved}\` });
      return;
    }
    // Size limit: 1MB
    if (stat.size > 1024 * 1024) {
      send(ws, { type: 'error', requestId, message: \`File too large (\${stat.size} bytes, max 1MB): \${resolved}\` });
      return;
    }
    const encoding = (opts && opts.encoding) || 'utf8';
    const validEncodings = ['utf8', 'utf-8', 'ascii', 'base64', 'hex', 'latin1', 'binary'];
    const enc = validEncodings.includes(encoding) ? encoding : 'utf8';
    const content = fs.readFileSync(resolved, enc);
    send(ws, { type: 'fileRead', requestId, filePath: resolved, content, size: stat.size });
  } catch (err) {
    send(ws, { type: 'error', requestId, message: err.message });
  }
}

// ── listFiles handler ───────────────────────────────────────────────────────

function handleListFiles(ws, requestId, dirPath, opts) {
  if (!requestId) {
    send(ws, { type: 'error', requestId, message: 'requestId is required' });
    return;
  }

  const resolved = path.resolve(currentCwd, dirPath || '.');

  // Home directory restriction
  const homeDir = os.homedir();
  if (!resolved.startsWith(homeDir + path.sep) && resolved !== homeDir) {
    send(ws, { type: 'error', requestId, message: \`List blocked: path outside home directory: \${resolved}\` });
    return;
  }

  const recursive = opts && opts.recursive;
  const maxDepth = (opts && opts.maxDepth) || 3;
  const includeHidden = opts && opts.includeHidden;

  console.log(\`[shelly-bridge] [\${requestId}] LIST_FILES: \${resolved} (recursive=\${!!recursive}, maxDepth=\${maxDepth})\`);

  try {
    if (!fs.existsSync(resolved)) {
      send(ws, { type: 'error', requestId, message: \`No such directory: \${resolved}\` });
      return;
    }
    if (!fs.statSync(resolved).isDirectory()) {
      send(ws, { type: 'error', requestId, message: \`Not a directory: \${resolved}\` });
      return;
    }

    const entries = [];
    const IGNORE_DIRS = new Set(['node_modules', '.git', '.expo', '__pycache__', '.cache', 'dist', 'build', '.next']);

    function walk(dir, depth) {
      if (depth > maxDepth) return;
      let items;
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch { return; }

      for (const item of items) {
        if (!includeHidden && item.name.startsWith('.') && depth > 0) continue;
        if (IGNORE_DIRS.has(item.name) && item.isDirectory()) continue;

        const fullPath = path.join(dir, item.name);
        const relativePath = path.relative(resolved, fullPath);
        const isDir = item.isDirectory();

        let size = 0;
        if (!isDir) {
          try { size = fs.statSync(fullPath).size; } catch {}
        }

        entries.push({
          name: item.name,
          path: relativePath,
          isDirectory: isDir,
          size,
        });

        if (isDir && recursive) {
          walk(fullPath, depth + 1);
        }
      }
    }

    walk(resolved, 0);
    send(ws, { type: 'fileList', requestId, dirPath: resolved, entries, total: entries.length });
  } catch (err) {
    send(ws, { type: 'error', requestId, message: err.message });
  }
}

// ── editFile handler (diff-patch) ───────────────────────────────────────────

function handleEditFile(ws, requestId, filePath, edits) {
  if (!requestId || !filePath || !Array.isArray(edits)) {
    send(ws, { type: 'error', requestId, message: 'requestId, filePath, and edits[] are required' });
    return;
  }

  const resolved = path.resolve(currentCwd, filePath);

  // Home directory restriction
  const homeDir = os.homedir();
  if (!resolved.startsWith(homeDir + path.sep) && resolved !== homeDir) {
    send(ws, { type: 'error', requestId, message: \`Edit blocked: path outside home directory: \${resolved}\` });
    return;
  }

  console.log(\`[shelly-bridge] [\${requestId}] EDIT_FILE: \${resolved} (\${edits.length} edits)\`);

  try {
    if (!fs.existsSync(resolved)) {
      send(ws, { type: 'error', requestId, message: \`No such file: \${resolved}\` });
      return;
    }

    let content = fs.readFileSync(resolved, 'utf8');
    let applied = 0;

    for (const edit of edits) {
      if (!edit.oldText && edit.oldText !== '') continue;
      if (edit.newText == null) continue;

      const occurrences = content.split(edit.oldText).length - 1;
      if (occurrences === 1) {
        content = content.replace(edit.oldText, edit.newText);
        applied++;
      } else if (occurrences > 1) {
        send(ws, { type: 'error', requestId, message: \`Edit \${applied + 1} failed: oldText matches \${occurrences} times (must be unique)\` });
        return;
      } else {
        send(ws, { type: 'error', requestId, message: \`Edit \${applied + 1} failed: oldText not found in file\` });
        return;
      }
    }

    fs.writeFileSync(resolved, content, 'utf8');
    send(ws, { type: 'fileEdited', requestId, filePath: resolved, editsApplied: applied });
  } catch (err) {
    send(ws, { type: 'error', requestId, message: err.message });
  }
}

// ── openFolder handler ──────────────────────────────────────────────────────

function handleOpenFolder(ws, requestId, folderPath) {
  if (!requestId || !folderPath) {
    send(ws, { type: 'error', requestId, message: 'requestId and folderPath are required' });
    return;
  }

  const resolved = path.resolve(currentCwd, folderPath);
  console.log(\`[shelly-bridge] [\${requestId}] OPEN_FOLDER: \${resolved}\`);

  try {
    if (!fs.existsSync(resolved)) {
      send(ws, { type: 'error', requestId, message: \`No such directory: \${resolved}\` });
      return;
    }
    if (!fs.statSync(resolved).isDirectory()) {
      send(ws, { type: 'error', requestId, message: \`Not a directory: \${resolved}\` });
      return;
    }
    currentCwd = resolved;
    send(ws, { type: 'exit', requestId, code: 0, cwd: currentCwd });
  } catch (err) {
    send(ws, { type: 'error', requestId, message: err.message });
  }
}

// ── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });

wss.on('listening', () => {
  console.log(\`[shelly-bridge] Server listening on ws://127.0.0.1:\${PORT}\`);
  console.log(\`[shelly-bridge] CWD: \${currentCwd}\`);
  console.log(\`[shelly-bridge] Dangerous command check: \${DANGEROUS_CHECK ? 'ON' : 'OFF'}\`);
});

wss.on('connection', (ws) => {
  console.log('[shelly-bridge] Client connected');
  send(ws, { type: 'ready', cwd: currentCwd });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    switch (msg.type) {
      case 'run':
        handleRun(ws, msg.requestId, msg.command);
        break;
      case 'exec':
        // exec is the same as run — used by Chat tab's bridgeRunCommand
        handleRun(ws, msg.requestId, msg.cmd || msg.command, {
          cwd: msg.cwd,
          env: msg.env,
        });
        break;
      case 'stdin':
        handleStdin(ws, msg.requestId, msg.data);
        break;
      case 'cancel':
        handleCancel(ws, msg.requestId);
        break;
      case 'createProject':
        handleCreateProject(ws, msg.requestId, msg.projectPath, msg.files);
        break;
      case 'writeFile':
        handleWriteFile(ws, msg.requestId, msg.filePath, msg.content, msg.encoding);
        break;
      case 'readFile':
        handleReadFile(ws, msg.requestId, msg.filePath, { encoding: msg.encoding });
        break;
      case 'listFiles':
        handleListFiles(ws, msg.requestId, msg.dirPath, {
          recursive: msg.recursive,
          maxDepth: msg.maxDepth,
          includeHidden: msg.includeHidden,
        });
        break;
      case 'editFile':
        handleEditFile(ws, msg.requestId, msg.filePath, msg.edits);
        break;
      case 'openFolder':
        handleOpenFolder(ws, msg.requestId, msg.folderPath);
        break;
      case 'ping':
        send(ws, { type: 'pong' });
        break;
      default:
        send(ws, { type: 'error', message: \`Unknown type: \${msg.type}\` });
    }
  });

  ws.on('close', () => {
    console.log('[shelly-bridge] Client disconnected');
    // Kill active process when client disconnects
    if (activeProcess && activeWs === ws) {
      try { activeProcess.kill('SIGKILL'); } catch (_) {}
      activeProcess = null;
      activeRequestId = null;
      activeWs = null;
    }
  });
});

wss.on('error', (err) => {
  console.error(\`[shelly-bridge] Server error: \${err.message}\`);
  if (err.code === 'EADDRINUSE') {
    console.error(\`[shelly-bridge] Port \${PORT} is already in use. Kill the other process or use SHELLY_PORT=<port>\`);
    process.exit(1);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\\n[shelly-bridge] Shutting down...');
  if (activeProcess) {
    try { activeProcess.kill('SIGKILL'); } catch (_) {}
  }
  wss.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  if (activeProcess) {
    try { activeProcess.kill('SIGKILL'); } catch (_) {}
  }
  wss.close(() => process.exit(0));
});
`;

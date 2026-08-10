/**
 * Auto Savepoint — Git operations for game-like auto-save.
 * Users never see git terminology. All commands run via bridge.
 */

type RunCommandFn = (cmd: string) => Promise<{ stdout: string; exitCode: number }>;

// ─── Security patterns (checked before every auto-commit) ──────────────────

export type SecurityIssue = { file: string; label: string; line: number };

const SECURITY_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\b(api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{8,}/i, label: 'hardcoded secret' },
  { pattern: /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----/, label: 'private key' },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, label: 'Google API key' },
  { pattern: /\bsk-[a-zA-Z0-9]{20,}\b/, label: 'OpenAI/Anthropic key' },
  { pattern: /\bghp_[a-zA-Z0-9]{36}\b/, label: 'GitHub PAT' },
];

const SENSITIVE_FILES = /\.(env|env\.local|env\.production|pem|key|p12|jks|keystore)$/;

const SKIP_PREFIXES = [
  '.npm/', 'node_modules/', '.shelly-cli/', '.shelly-rootfs/',
  '.cache/', '.local/', '.config/', '.yarn/',
];
const MAX_FILES_TO_SCAN = 30;
const MAX_LINES_PER_FILE = 500;

type ScanSource = 'staged' | 'worktree';

async function scanFilesForSecrets(
  projectDir: string,
  runCommand: RunCommandFn,
  source: ScanSource,
): Promise<SecurityIssue[]> {
  const dir = shellEscape(projectDir);
  const listCommand = source === 'staged'
    ? `git -C ${dir} diff --cached --name-only`
    : `git -C ${dir} ls-files --others --modified --exclude-standard`;
  const { stdout: listedFiles, exitCode: listExitCode } = await runCommand(listCommand);
  if (listExitCode !== 0) {
    return [{ file: '.', label: 'secret scan failed: could not list files', line: 0 }];
  }
  if (!listedFiles.trim()) return [];

  const filesToScan = listedFiles.trim().split('\n').filter(Boolean).filter(
    (f) => !SKIP_PREFIXES.some((p) => f.startsWith(p)),
  );
  if (filesToScan.length > MAX_FILES_TO_SCAN) {
    return [{
      file: filesToScan[MAX_FILES_TO_SCAN],
      label: `secret scan limit exceeded: more than ${MAX_FILES_TO_SCAN} files`,
      line: 0,
    }];
  }

  const issues: SecurityIssue[] = [];
  for (const file of filesToScan) {
    if (SENSITIVE_FILES.test(file)) {
      issues.push({ file, label: 'sensitive file', line: 0 });
      continue;
    }
    const readCommand = source === 'staged'
      ? `git -C ${dir} show :${shellEscape(file)}`
      : `cd ${dir} && head -n ${MAX_LINES_PER_FILE + 1} -- ${shellEscape(file)}`;
    const { stdout: content, exitCode } = await runCommand(readCommand);
    if (exitCode !== 0) {
      issues.push({ file, label: 'secret scan failed: could not read file', line: 0 });
      continue;
    }
    const lines = content.split('\n');
    if (content.endsWith('\n')) lines.pop();
    if (lines.length > MAX_LINES_PER_FILE) {
      issues.push({
        file,
        label: `secret scan limit exceeded: more than ${MAX_LINES_PER_FILE} lines`,
        line: MAX_LINES_PER_FILE + 1,
      });
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      for (const { pattern, label } of SECURITY_PATTERNS) {
        if (pattern.test(lines[i])) issues.push({ file, label, line: i + 1 });
      }
    }
  }
  return issues;
}

/** Scan staged files for secrets. Returns issues found. */
export async function scanForSecrets(
  projectDir: string,
  runCommand: RunCommandFn,
): Promise<SecurityIssue[]> {
  return scanFilesForSecrets(projectDir, runCommand, 'staged');
}

/** Shell-escape a string for safe use in single-quoted arguments */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export type SaveResult = {
  commitHash: string;
  message: string;
  filesChanged: number;
  filesCreated: number;
  filesDeleted: number;
};

const DEFAULT_GITIGNORE = `node_modules/
.expo/
*.log
.env
.env.*
*.key
*.pem
*.p12
*.jks
*.keystore
credentials.json
service-account*.json
dist/
build/
.DS_Store
`;

/** Check if directory has git repo, init if not.
 *
 * `requireRepoAtRoot` (2026-08-05 on-device fix, Galaxy Z Fold6 build ~1670):
 * the default detection (`git rev-parse --git-dir`) walks UP the directory
 * tree, so it answers "is this dir INSIDE any repo", not "is this dir a repo
 * root". That is fine for the savepoint bridge's project dirs (a checked-out
 * repo IS its own root), but it broke the agent-rollback workspace on any
 * device where an ancestor of $HOME/agent-output is itself a git repo — on the
 * verification device $HOME/.git exists, so rev-parse succeeded, `git init`
 * was skipped, and the baseline add/commit then ran against the HOME repo
 * (where they failed with exit 128 on a stale index.lock; even succeeding
 * would have been worse — committing the user's entire home dirt as the
 * agent's "baseline"). prepareRollbackWorkspace therefore fail-closed every
 * time and the Undo affordance could never appear. With the flag set,
 * detection is `test -e <dir>/.git` (a file, not just a dir — worktrees and
 * submodules use a .git FILE), so a workspace nested inside some ancestor
 * repo still gets its OWN repo rooted exactly at `projectDir`, which is the
 * invariant every other rollback step (status/add/commit/revert via
 * `git -C <root>`) silently assumed. */
export async function initGitIfNeeded(
  projectDir: string,
  runCommand: RunCommandFn,
  opts?: { requireRepoAtRoot?: boolean; onSecurityIssues?: (issues: SecurityIssue[]) => void },
): Promise<void> {
  const dir = shellEscape(projectDir);
  const { exitCode } = opts?.requireRepoAtRoot
    ? await runCommand(`test -e ${dir}/.git`)
    : await runCommand(`git -C ${dir} rev-parse --git-dir`);
  if (exitCode !== 0) {
    const initResult = await runCommand(`git -C ${dir} init`);
    if (initResult.exitCode !== 0) throw new Error(`git init failed (${initResult.exitCode})`);
    const { exitCode: igExists } = await runCommand(`test -f ${dir}/.gitignore`);
    if (igExists !== 0) {
      const escaped = DEFAULT_GITIGNORE.replace(/'/g, "'\\''");
      await runCommand(`printf '%s' '${escaped}' > ${dir}/.gitignore`);
    }
    const issues = await scanFilesForSecrets(projectDir, runCommand, 'worktree');
    if (issues.length > 0) {
      opts?.onSecurityIssues?.(issues);
      throw new Error(`initial secret scan failed: ${issues[0].label}`);
    }
    const addResult = await runCommand(`git -C ${dir} add -A`);
    if (addResult.exitCode !== 0) throw new Error(`git add failed (${addResult.exitCode})`);
    const commitResult = await runCommand(`git -C ${dir} commit -m "Auto: Initial savepoint" --allow-empty`);
    if (commitResult.exitCode !== 0) throw new Error(`git commit failed (${commitResult.exitCode})`);
  }
}

/** Check for uncommitted changes and commit if any.
 *  Scans for secrets before committing — skips commit if issues found. */
export async function checkAndSave(
  projectDir: string,
  runCommand: RunCommandFn,
  onSecurityIssues?: (issues: SecurityIssue[]) => void,
): Promise<SaveResult | null> {
  const dir = shellEscape(projectDir);
  const { stdout: status } = await runCommand(`git -C ${dir} status --porcelain`);
  if (!status.trim()) return null;

  const message = generateCommitMessage(status);
  const changedCount = status.trim().split('\n').filter(Boolean).length;
  console.log('[AutoSave] changes detected:', changedCount, 'files in', projectDir);

  const { exitCode: addExitCode } = await runCommand(`git -C ${dir} add -A`);
  if (addExitCode !== 0) {
    console.warn('[AutoSave] git add failed, exitCode=', addExitCode);
    return null;
  }

  // Security gate: scan staged files for secrets before committing
  const issues = await scanForSecrets(projectDir, runCommand);
  if (issues.length > 0) {
    console.warn('[AutoSave] BLOCKED — secrets detected:', issues.map(i => `${i.file}:${i.line} (${i.label})`).join(', '));
    // Unstage everything and notify caller
    await runCommand(`git -C ${dir} reset HEAD`);
    onSecurityIssues?.(issues);
    return null;
  }

  const { exitCode } = await runCommand(
    `git -C ${dir} commit -m "${message.replace(/"/g, '\\"')}"`,
  );
  if (exitCode !== 0) {
    console.warn('[AutoSave] commit failed, exitCode=', exitCode);
    return null;
  }

  const { stdout: hash } = await runCommand(`git -C ${dir} rev-parse --short HEAD`);
  console.log('[AutoSave] committed:', hash.trim(), message);

  const lines = status.trim().split('\n').filter(Boolean);
  const created = lines.filter((l) => l.startsWith('?') || l.startsWith('A')).length;
  const deleted = lines.filter((l) => l.startsWith('D')).length;
  const modified = lines.length - created - deleted;

  return {
    commitHash: hash.trim(),
    message,
    filesChanged: modified,
    filesCreated: created,
    filesDeleted: deleted,
  };
}

/** Generate human-readable commit message from git status --porcelain */
export function generateCommitMessage(status: string): string {
  const lines = status.trim().split('\n').filter(Boolean);
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const line of lines) {
    const code = line.slice(0, 2).trim();
    const file = line.slice(3).trim();
    const name = file.split('/').pop() ?? file;
    if (code === '??' || code === 'A') created.push(name);
    else if (code === 'D') deleted.push(name);
    else modified.push(name);
  }

  if (created.length && !modified.length && !deleted.length) {
    return created.length === 1
      ? `Auto: Created ${created[0]}`
      : `Auto: Created ${created.length} files`;
  }
  if (modified.length && !created.length && !deleted.length) {
    return modified.length === 1
      ? `Auto: Updated ${modified[0]}`
      : `Auto: Updated ${modified.length} files`;
  }
  if (deleted.length && !created.length && !modified.length) {
    return deleted.length === 1
      ? `Auto: Removed ${deleted[0]}`
      : `Auto: Removed ${deleted.length} files`;
  }

  const parts: string[] = [];
  if (modified.length) parts.push(`modified ${modified.length}`);
  if (created.length) parts.push(`created ${created.length}`);
  if (deleted.length) parts.push(`removed ${deleted.length}`);
  return `Auto: ${parts.join(', ')} files`;
}

/** Revert the last commit */
export async function revertLastSavepoint(
  projectDir: string,
  runCommand: RunCommandFn,
): Promise<boolean> {
  const dir = shellEscape(projectDir);
  console.log('[AutoSave] reverting last savepoint in', projectDir);
  const { exitCode } = await runCommand(`git -C ${dir} revert HEAD --no-edit`);
  if (exitCode !== 0) {
    console.warn('[AutoSave] revert failed, aborting');
    await runCommand(`git -C ${dir} revert --abort`);
    return false;
  }
  console.log('[AutoSave] revert succeeded');
  return true;
}

/**
 * Revert ONE specific savepoint by hash (non-destructive: adds an inverse
 * commit). Used by the agent rollback tier (lib/agent-rollback.ts), where the
 * commit to undo is known and may no longer be HEAD by the time the user taps
 * "元に戻す" — reverting HEAD blindly would then undo the wrong thing.
 *
 * The hash is VALIDATED, not sanitized. checkoutSavepoint's strip-to-hex
 * approach is injection-safe but not correctness-safe: stripping turns garbage
 * like "$(whoami)" into the plausible short hash "a", which git may resolve to
 * an unrelated commit — and here that would revert the WRONG work. Every hash
 * this function is given came from our own `git rev-parse --short HEAD`, so
 * anything that isn't a well-formed hash is a bug, and refusing is correct.
 */
const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/;

export async function revertSavepoint(
  projectDir: string,
  hash: string,
  runCommand: RunCommandFn,
): Promise<boolean> {
  const dir = shellEscape(projectDir);
  const safeHash = hash.trim().toLowerCase();
  if (!COMMIT_HASH_RE.test(safeHash)) {
    console.warn('[AutoSave] refusing revert: malformed commit hash');
    return false;
  }
  const { exitCode } = await runCommand(`git -C ${dir} revert ${safeHash} --no-edit`);
  if (exitCode !== 0) {
    console.warn('[AutoSave] revert of', safeHash, 'failed, aborting');
    await runCommand(`git -C ${dir} revert --abort`);
    return false;
  }
  return true;
}

/** Get diff of last commit for "view changes" */
export async function getLastDiff(
  projectDir: string,
  runCommand: RunCommandFn,
): Promise<string> {
  const dir = shellEscape(projectDir);
  const { stdout } = await runCommand(`git -C ${dir} diff HEAD~1 HEAD`);
  return stdout;
}

// ─── Timeline (セーブポイント一覧) ──────────────────────────────────────────

export type TimelineEntry = {
  hash: string;
  message: string;
  relativeTime: string;
};

/** Get commit timeline for project (savepoint history) */
export async function getTimeline(
  projectDir: string,
  runCommand: RunCommandFn,
  limit: number = 20,
): Promise<TimelineEntry[]> {
  const dir = shellEscape(projectDir);
  const { stdout, exitCode } = await runCommand(
    `git -C ${dir} log --oneline --format='%h|%s|%cr' -${limit} 2>/dev/null`,
  );
  if (exitCode !== 0 || !stdout.trim()) return [];
  return stdout.trim().split('\n').map((line) => {
    const parts = line.split('|');
    const hash = parts[0] ?? '';
    const message = parts[1] ?? '';
    const relativeTime = parts.slice(2).join('|'); // relativeTime may contain '|' in some locales
    return { hash, message, relativeTime };
  });
}

/** Checkout a specific savepoint */
export async function checkoutSavepoint(
  projectDir: string,
  hash: string,
  runCommand: RunCommandFn,
): Promise<boolean> {
  const dir = shellEscape(projectDir);
  // Sanitize hash: only allow hex characters
  const safeHash = hash.replace(/[^a-f0-9]/gi, '');
  if (!safeHash) return false;
  const { exitCode } = await runCommand(`git -C ${dir} checkout ${safeHash}`);
  return exitCode === 0;
}

/** Get diff between a savepoint and current HEAD */
export async function getDiffFromSavepoint(
  projectDir: string,
  hash: string,
  runCommand: RunCommandFn,
): Promise<string> {
  const dir = shellEscape(projectDir);
  const safeHash = hash.replace(/[^a-f0-9]/gi, '');
  if (!safeHash) return '';
  const { stdout } = await runCommand(`git -C ${dir} diff ${safeHash} HEAD`);
  return stdout;
}

/** Detect if a command likely modifies files */
export function isFileChangingCommand(command: string): boolean {
  const cmd = command.trim().split(/\s+/)[0];
  const changingCommands = [
    'npm', 'npx', 'pnpm', 'yarn', 'bun',
    'touch', 'mkdir', 'cp', 'mv', 'rm',
    'sed', 'awk',
    'vi', 'vim', 'nano', 'code',
    'pip', 'pip3', 'python', 'node',
    'make', 'cmake', 'cargo', 'go',
    'wget', 'curl',
    'tar', 'unzip', 'gzip',
    'chmod', 'chown',
  ];
  if (command.includes('>') || command.includes('>>')) return true;
  return changingCommands.includes(cmd);
}

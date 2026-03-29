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

/** Scan staged files for secrets. Returns issues found. */
export async function scanForSecrets(
  projectDir: string,
  runCommand: RunCommandFn,
): Promise<SecurityIssue[]> {
  const dir = shellEscape(projectDir);
  const { stdout: stagedFiles } = await runCommand(`git -C ${dir} diff --cached --name-only`);
  if (!stagedFiles.trim()) return [];

  const issues: SecurityIssue[] = [];
  for (const file of stagedFiles.trim().split('\n')) {
    if (!file) continue;
    // Check filename patterns
    if (SENSITIVE_FILES.test(file)) {
      issues.push({ file, label: 'sensitive file', line: 0 });
      continue;
    }
    // Check file content for secret patterns
    const { stdout: content, exitCode } = await runCommand(
      `git -C ${dir} show :${shellEscape(file)} 2>/dev/null | head -500`,
    );
    if (exitCode !== 0 || !content) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const { pattern, label } of SECURITY_PATTERNS) {
        if (pattern.test(lines[i])) {
          issues.push({ file, label, line: i + 1 });
        }
      }
    }
  }
  return issues;
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

/** Check if directory has git repo, init if not */
export async function initGitIfNeeded(
  projectDir: string,
  runCommand: RunCommandFn,
): Promise<void> {
  const dir = shellEscape(projectDir);
  const { exitCode } = await runCommand(`git -C ${dir} rev-parse --git-dir`);
  if (exitCode !== 0) {
    await runCommand(`git -C ${dir} init`);
    const { exitCode: igExists } = await runCommand(`test -f ${dir}/.gitignore`);
    if (igExists !== 0) {
      const escaped = DEFAULT_GITIGNORE.replace(/'/g, "'\\''");
      await runCommand(`printf '%s' '${escaped}' > ${dir}/.gitignore`);
    }
    await runCommand(`git -C ${dir} add -A`);
    await runCommand(`git -C ${dir} commit -m "Auto: Initial savepoint" --allow-empty`);
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

  await runCommand(`git -C ${dir} add -A`);

  // Security gate: scan staged files for secrets before committing
  const issues = await scanForSecrets(projectDir, runCommand);
  if (issues.length > 0) {
    // Unstage everything and notify caller
    await runCommand(`git -C ${dir} reset HEAD`);
    onSecurityIssues?.(issues);
    return null;
  }

  const { exitCode } = await runCommand(
    `git -C ${dir} commit -m "${message.replace(/"/g, '\\"')}"`,
  );
  if (exitCode !== 0) return null;

  const { stdout: hash } = await runCommand(`git -C ${dir} rev-parse --short HEAD`);

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
  const { exitCode } = await runCommand(`git -C ${dir} revert HEAD --no-edit`);
  if (exitCode !== 0) {
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

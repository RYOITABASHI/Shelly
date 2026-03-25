/**
 * lib/github-actions.ts — GitHub Actions workflow generation and status checking.
 *
 * Detects project type, generates CI workflow YAML,
 * and queries workflow run status via the GitHub API.
 */

import type { ActionsWizardData } from '@/store/chat-store';
import { getGitHubPAT } from '@/lib/github-auth';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ActionKind = 'build' | 'test' | 'deploy' | 'release';
export type TriggerKind = 'push' | 'daily' | 'manual';

/**
 * Detect the project type from package.json contents.
 */
export function detectProjectType(
  packageJson: any,
): 'node' | 'python' | 'static' | 'unknown' {
  if (!packageJson) return 'unknown';

  // Node project: has dependencies or scripts
  if (
    packageJson.dependencies ||
    packageJson.devDependencies ||
    packageJson.scripts
  ) {
    return 'node';
  }

  return 'unknown';
}

/**
 * Detect project type by reading package.json via shell.
 */
export async function detectProjectTypeFromDir(
  projectDir: string,
  runCommand: (cmd: string) => Promise<{ stdout: string; exitCode: number | null }>,
): Promise<string> {
  try {
    const { stdout, exitCode } = await runCommand(
      `cat ${JSON.stringify(projectDir + '/package.json')} 2>/dev/null`,
    );
    if (exitCode === 0 && stdout.trim()) {
      const pkg = JSON.parse(stdout);
      return detectProjectType(pkg);
    }
  } catch { /* ignore */ }

  // Check for Python
  try {
    const { exitCode } = await runCommand(
      `test -f ${JSON.stringify(projectDir + '/requirements.txt')} || test -f ${JSON.stringify(projectDir + '/setup.py')} || test -f ${JSON.stringify(projectDir + '/pyproject.toml')}`,
    );
    if (exitCode === 0) return 'python';
  } catch { /* ignore */ }

  return 'unknown';
}

// ─── Trigger block generation ─────────────────────────────────────────────────

function generateTriggerBlock(trigger: TriggerKind): string {
  switch (trigger) {
    case 'push':
      return `on:
  push:
    branches: [main]
  pull_request:
    branches: [main]`;
    case 'daily':
      return `on:
  schedule:
    - cron: '0 0 * * *'
  workflow_dispatch:`;
    case 'manual':
      return `on:
  workflow_dispatch:`;
  }
}

// ─── Step generators per action kind ──────────────────────────────────────────

function nodeSetupSteps(): string {
  return `      - uses: actions/checkout@v4

      - name: Use Node.js 20
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - name: Install dependencies
        run: npm ci`;
}

function pythonSetupSteps(): string {
  return `      - uses: actions/checkout@v4

      - name: Set up Python 3.12
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install dependencies
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements.txt 2>/dev/null || true`;
}

function genericSetupSteps(): string {
  return `      - uses: actions/checkout@v4`;
}

function setupStepsForType(projectType: string): string {
  if (projectType === 'node') return nodeSetupSteps();
  if (projectType === 'python') return pythonSetupSteps();
  return genericSetupSteps();
}

function buildStep(projectType: string): string {
  const cmd = projectType === 'node' ? 'npm run build' : projectType === 'python' ? 'python setup.py build 2>/dev/null || echo "No build step"' : 'echo "No build step"';
  return `      - name: Build
        run: ${cmd}`;
}

function testStep(projectType: string): string {
  const cmd = projectType === 'node' ? 'npm test' : projectType === 'python' ? 'python -m pytest 2>/dev/null || echo "No test step"' : 'echo "No test step"';
  return `      - name: Test
        run: ${cmd}`;
}

/**
 * Generate a GitHub Actions workflow YAML from wizard selections.
 */
export function generateWorkflowFromWizard(data: ActionsWizardData): string {
  const projectType = data.projectType || 'unknown';
  const trigger = data.trigger || 'push';
  const actions = data.actions;

  const triggerBlock = generateTriggerBlock(trigger);
  const setup = setupStepsForType(projectType);

  const steps: string[] = [setup];

  if (actions.includes('build')) {
    steps.push(buildStep(projectType));
  }
  if (actions.includes('test')) {
    steps.push(testStep(projectType));
  }

  // Build job name from selected actions
  const jobActions = actions.filter((a) => a === 'build' || a === 'test');
  const jobName = jobActions.length > 0
    ? jobActions.map((a) => a.charAt(0).toUpperCase() + a.slice(1)).join(' & ')
    : 'CI';

  let yaml = `name: ${jobName}

${triggerBlock}

jobs:
  ci:
    runs-on: ubuntu-latest

    steps:
${steps.join('\n\n')}
`;

  // Deploy job (separate)
  if (actions.includes('deploy')) {
    yaml += `
  deploy:
    runs-on: ubuntu-latest
    needs: ci
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'

    steps:
      - uses: actions/checkout@v4

      - name: Deploy
        run: echo "Add your deploy commands here"
`;
  }

  // Release job (separate)
  if (actions.includes('release')) {
    yaml += `
  release:
    runs-on: ubuntu-latest
    needs: ci
    if: startsWith(github.ref, 'refs/tags/')

    steps:
      - uses: actions/checkout@v4

      - name: Create Release
        uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
`;
  }

  return yaml;
}

/**
 * Generate a GitHub Actions workflow YAML string (legacy API).
 */
export function generateWorkflow(
  projectType: string,
  options?: { buildCmd?: string; testCmd?: string },
): string {
  const buildCmd = options?.buildCmd ?? (projectType === 'node' ? 'npm run build' : 'echo "No build step"');
  const testCmd = options?.testCmd ?? (projectType === 'node' ? 'npm test' : 'echo "No test step"');

  if (projectType === 'node') {
    return `name: Build & Test

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest

    strategy:
      matrix:
        node-version: [18, 20]

    steps:
      - uses: actions/checkout@v4

      - name: Use Node.js \${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node-version }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: ${buildCmd}

      - name: Test
        run: ${testCmd}
`;
  }

  if (projectType === 'python') {
    return `name: Build & Test

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest

    strategy:
      matrix:
        python-version: ['3.10', '3.11', '3.12']

    steps:
      - uses: actions/checkout@v4

      - name: Set up Python \${{ matrix.python-version }}
        uses: actions/setup-python@v5
        with:
          python-version: \${{ matrix.python-version }}

      - name: Install dependencies
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements.txt 2>/dev/null || true

      - name: Build
        run: ${buildCmd}

      - name: Test
        run: ${testCmd}
`;
  }

  // static / unknown — basic checkout + optional build
  return `name: Build & Test

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Build
        run: ${buildCmd}

      - name: Test
        run: ${testCmd}
`;
}

/**
 * Write workflow file and commit+push it.
 */
export async function commitAndPushWorkflow(params: {
  projectDir: string;
  yaml: string;
  runCommand: (cmd: string) => Promise<{ stdout: string; exitCode: number | null }>;
}): Promise<{ success: boolean; error?: string }> {
  const { projectDir, yaml, runCommand } = params;
  const dir = JSON.stringify(projectDir);
  const workflowDir = `${projectDir}/.github/workflows`;

  try {
    await runCommand(`mkdir -p ${JSON.stringify(workflowDir)}`);

    // Write YAML to file via heredoc
    const escaped = yaml.replace(/'/g, "'\\''");
    const writeResult = await runCommand(
      `cat > ${JSON.stringify(workflowDir + '/ci.yml')} << 'SHELLY_EOF'\n${yaml}SHELLY_EOF`,
    );
    if (writeResult.exitCode !== 0) {
      return { success: false, error: 'Failed to write workflow file' };
    }

    // git add + commit
    const addResult = await runCommand(`git -C ${dir} add .github/workflows/ci.yml`);
    if (addResult.exitCode !== 0) {
      return { success: false, error: 'git add failed' };
    }

    const commitResult = await runCommand(
      `git -C ${dir} commit -m "ci: add GitHub Actions workflow (via Shelly)"`,
    );
    if (commitResult.exitCode !== 0) {
      return { success: false, error: 'git commit failed' };
    }

    // Push (uses existing remote auth)
    const pushResult = await runCommand(`git -C ${dir} push origin main`);
    if (pushResult.exitCode !== 0) {
      return { success: false, error: 'git push failed — check remote and auth' };
    }

    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message || 'Unknown error' };
  }
}

/**
 * Fetch the latest workflow run for a repo.
 */
export async function getLatestWorkflowRun(params: {
  owner: string;
  repo: string;
  pat: string;
}): Promise<{
  status: string;
  conclusion: string | null;
  url: string;
  updatedAt: string;
} | null> {
  const { owner, repo, pat } = params;

  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=1`,
      {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );

    if (!res.ok) return null;

    const data = await res.json();
    const runs = data.workflow_runs;
    if (!runs || runs.length === 0) return null;

    const run = runs[0];
    return {
      status: run.status,
      conclusion: run.conclusion,
      url: run.html_url,
      updatedAt: run.updated_at,
    };
  } catch {
    return null;
  }
}

/**
 * Get workflow run logs URL.
 * Returns the download URL for the logs zip, or null on failure.
 */
export async function getWorkflowLogs(params: {
  owner: string;
  repo: string;
  runId: number;
  pat: string;
}): Promise<string | null> {
  const { owner, repo, runId, pat } = params;

  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/logs`,
      {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/vnd.github+json',
        },
        redirect: 'manual',
      },
    );

    // The API returns a 302 redirect to the actual download URL
    if (res.status === 302) {
      return res.headers.get('location');
    }

    return null;
  } catch {
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract owner/repo from a GitHub remote URL.
 * Supports https and git@ formats.
 */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  // https://github.com/OWNER/REPO.git or https://<pat>@github.com/OWNER/REPO.git
  const httpsMatch = url.match(/github\.com[/:]([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  return null;
}

// ─── Workflow result polling ──────────────────────────────────────────────────

export type WorkflowPollResult = {
  status: 'success' | 'failure' | 'timeout' | 'error';
  url?: string;
  conclusion?: string | null;
};

/**
 * Poll GitHub Actions for the latest workflow run result.
 *
 * Starts after `initialDelayMs` (default 90s), then checks every `intervalMs`
 * (default 15s) up to `maxAttempts` (default 10) times.
 *
 * Returns as soon as the run completes, or 'timeout' if still in progress.
 */
export async function pollWorkflowResult(params: {
  projectDir: string;
  runCommand: (cmd: string) => Promise<{ stdout: string; exitCode: number | null }>;
  initialDelayMs?: number;
  intervalMs?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
}): Promise<WorkflowPollResult> {
  const {
    projectDir,
    runCommand,
    initialDelayMs = 90_000,
    intervalMs = 15_000,
    maxAttempts = 10,
    signal,
  } = params;

  // Get PAT
  const pat = await getGitHubPAT();
  if (!pat) return { status: 'error' };

  // Get remote URL → owner/repo
  const dir = JSON.stringify(projectDir);
  const { stdout: remoteUrl, exitCode } = await runCommand(
    `git -C ${dir} remote get-url origin 2>/dev/null`,
  );
  if (exitCode !== 0 || !remoteUrl.trim()) return { status: 'error' };

  const parsed = parseGitHubRemote(remoteUrl.trim());
  if (!parsed) return { status: 'error' };

  // Wait for Actions to start
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, initialDelayMs);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(undefined); });
  });

  // Poll
  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) return { status: 'error' };

    const run = await getLatestWorkflowRun({ owner: parsed.owner, repo: parsed.repo, pat });
    if (run && run.status === 'completed') {
      return {
        status: run.conclusion === 'success' ? 'success' : 'failure',
        url: run.url,
        conclusion: run.conclusion,
      };
    }

    // Wait before next attempt
    if (i < maxAttempts - 1) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(undefined); });
      });
    }
  }

  return { status: 'timeout' };
}

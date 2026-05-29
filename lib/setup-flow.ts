/**
 * lib/setup-flow.ts — Interactive terminal setup orchestrator
 *
 * Manages the step-by-step setup flow triggered by `shelly setup`.
 * Emits SetupBlock entries to terminal-store for rendering in BlockList.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Linking } from 'react-native';
import { execCommand } from '@/hooks/use-native-exec';
import { logInfo, logError } from '@/lib/debug-logger';
import type { SetupBlock, SetupStepId } from '@/store/types';
import type { AuthToolId } from '@/lib/cli-auth';

// ── Constants ────────────────────────────────────────────────────────────────

const SETUP_KEY = '@shelly/setup_wizard_complete';

const CLI_TOOLS: Array<{
  id: AuthToolId;
  name: string;
  npm: string;
  bin: string;
  color: string;
  free?: boolean;
}> = [
  { id: 'codex', name: 'Codex CLI', npm: '@openai/codex', bin: 'codex', color: '#10A37F' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

let blockCounter = 0;
function makeBlockId(): string {
  return `setup-${Date.now()}-${++blockCounter}`;
}

// ── SetupFlow class ─────────────────────────────────────────────────────────

export class SetupFlow {
  private addBlock: (block: SetupBlock) => void;
  private updateBlock: (id: string, updates: Partial<SetupBlock>) => void;
  private sessionId: string;
  private mode: 'full' | 'cli' | 'git' | 'projects' = 'full';
  private selectedClis: Set<AuthToolId> = new Set();
  private currentBlockId: string = '';
  private onShowOverlay: (show: boolean) => void;

  constructor(
    addBlock: (block: SetupBlock) => void,
    updateBlock: (id: string, updates: Partial<SetupBlock>) => void,
    sessionId: string,
    onShowOverlay: (show: boolean) => void,
  ) {
    this.addBlock = addBlock;
    this.updateBlock = updateBlock;
    this.sessionId = sessionId;
    this.onShowOverlay = onShowOverlay;
  }

  // ── Public entry points ─────────────────────────────────────────────────

  async startFull(): Promise<void> {
    this.mode = 'full';
    logInfo('SetupFlow', 'Starting full setup');
    this.onShowOverlay(true);
    this.emitWelcome();
  }

  async startCli(): Promise<void> {
    this.mode = 'cli';
    logInfo('SetupFlow', 'Starting CLI setup');
    this.onShowOverlay(true);
    this.emitCliSelect();
  }

  async startGit(): Promise<void> {
    this.mode = 'git';
    logInfo('SetupFlow', 'Starting Git setup');
    this.onShowOverlay(true);
    await this.emitGitConfig();
  }

  async startProjects(): Promise<void> {
    this.mode = 'projects';
    logInfo('SetupFlow', 'Starting Projects setup');
    this.onShowOverlay(true);
    await this.emitProjectScan();
  }

  // ── User interaction handlers ───────────────────────────────────────────

  async onOptionToggle(blockId: string, optionId: string): Promise<void> {
    // Find the block's current state from the entry and toggle the option
    if (this.currentBlockId !== blockId) return;

    if (optionId.startsWith('cli-')) {
      const cliId = optionId.replace('cli-', '') as AuthToolId;
      if (this.selectedClis.has(cliId)) {
        this.selectedClis.delete(cliId);
      } else {
        this.selectedClis.add(cliId);
      }
      // Update options to reflect selection
      this.updateBlock(blockId, {
        options: CLI_TOOLS.map((cli) => ({
          id: `cli-${cli.id}`,
          label: cli.name,
          description: cli.free ? `(free)` : '',
          color: cli.color,
          badge: cli.free ? 'FREE' : undefined,
          selected: this.selectedClis.has(cli.id),
        })),
      });
    } else {
      // Generic toggle for project folders etc.
      // Handled by the component directly updating the block
    }
  }

  async onAction(blockId: string, action: string): Promise<void> {
    logInfo('SetupFlow', `Action: ${action} on block ${blockId}`);

    switch (action) {
      case 'next-from-welcome':
        this.updateBlock(blockId, { status: 'completed' });
        this.emitCliSelect();
        break;

      case 'install-selected':
        this.updateBlock(blockId, { status: 'completed' });
        if (this.selectedClis.size === 0) {
          if (this.mode === 'full') {
            await this.emitGitConfig();
          } else {
            await this.emitDone();
          }
        } else {
          await this.runCliInstall();
        }
        break;

      case 'auth-browser': {
        const toolId = action; // will be overridden below
        break;
      }

      case 'auth-done':
        this.updateBlock(blockId, { status: 'completed' });
        if (this.mode === 'full') {
          await this.emitGitConfig();
        } else {
          await this.emitDone();
        }
        break;

      case 'git-save':
        // Handled via onInputSubmit
        break;

      case 'git-ssh-yes':
        this.updateBlock(blockId, { status: 'completed' });
        await this.generateSshKey();
        break;

      case 'git-ssh-no':
        this.updateBlock(blockId, { status: 'completed' });
        if (this.mode === 'full') {
          await this.emitProjectScan();
        } else {
          await this.emitDone();
        }
        break;

      case 'register-projects':
        // The component will call this with selected folder paths
        this.updateBlock(blockId, { status: 'completed' });
        await this.emitDone();
        break;

      case 'finish':
        this.updateBlock(blockId, { status: 'completed' });
        await AsyncStorage.setItem(SETUP_KEY, 'true');
        this.onShowOverlay(false);
        logInfo('SetupFlow', 'Setup complete');
        break;

      default:
        // Handle auth-browser-{toolId}
        if (action.startsWith('auth-browser-')) {
          const toolId = action.replace('auth-browser-', '') as AuthToolId;
          await this.startBrowserAuth(toolId, blockId);
        } else if (action.startsWith('auth-skip-')) {
          // Just continue, don't mark auth block as completed yet
          // It will be marked when all tools are done or skipped
        }
        break;
    }
  }

  async onInputSubmit(blockId: string, values: Record<string, string>): Promise<void> {
    logInfo('SetupFlow', `Input submit on block ${blockId}`);

    const name = values['git-name'];
    const email = values['git-email'];

    if (name && email) {
      this.updateBlock(blockId, {
        logLines: [`$ git config --global user.name "${name}"`, `$ git config --global user.email "${email}"`],
      });

      try {
        await execCommand(`git config --global user.name "${name}"`);
        await execCommand(`git config --global user.email "${email}"`);
        this.updateBlock(blockId, {
          status: 'completed',
          logLines: [
            `$ git config --global user.name "${name}"`,
            `$ git config --global user.email "${email}"`,
            '✓ Git configured',
          ],
        });
        // Move to SSH step
        this.emitGitSsh();
      } catch (e: any) {
        this.updateBlock(blockId, {
          status: 'error',
          errorMessage: e.message || 'Failed to configure git',
        });
      }
    }
  }

  async onSkip(blockId: string): Promise<void> {
    logInfo('SetupFlow', `Skip block ${blockId}`);
    this.updateBlock(blockId, { status: 'skipped' });

    // Determine what step was skipped and what comes next
    // Read the block's stepId from current context
    const stepId = this.getStepIdForBlock(blockId);

    switch (stepId) {
      case 'welcome':
      case 'cli-select':
        if (this.mode === 'full') {
          await this.emitGitConfig();
        } else {
          await this.emitDone();
        }
        break;
      case 'cli-install':
      case 'cli-auth':
        if (this.mode === 'full') {
          await this.emitGitConfig();
        } else {
          await this.emitDone();
        }
        break;
      case 'git-config':
      case 'git-input':
      case 'git-ssh':
        if (this.mode === 'full') {
          await this.emitProjectScan();
        } else {
          await this.emitDone();
        }
        break;
      case 'project-scan':
        await this.emitDone();
        break;
      default:
        await this.emitDone();
        break;
    }
  }

  async onBack(blockId: string): Promise<void> {
    logInfo('SetupFlow', `Back from block ${blockId}`);
    this.updateBlock(blockId, { status: 'skipped' });
    // For now, back just skips the current step
    // A full back-navigation is complex and not critical for v1
  }

  // ── Step emitters ───────────────────────────────────────────────────────

  private stepBlocks: Map<string, SetupStepId> = new Map();

  private getStepIdForBlock(blockId: string): SetupStepId {
    return this.stepBlocks.get(blockId) || 'welcome';
  }

  private emit(block: Omit<SetupBlock, 'id' | 'sessionId' | 'blockType' | 'timestamp'>): string {
    const id = makeBlockId();
    this.currentBlockId = id;
    this.stepBlocks.set(id, block.stepId);
    this.addBlock({
      ...block,
      id,
      sessionId: this.sessionId,
      blockType: 'setup',
      timestamp: Date.now(),
    } as SetupBlock);
    return id;
  }

  private emitWelcome(): void {
    this.emit({
      stepId: 'welcome',
      title: 'setup.welcome_title',
      description: 'setup.welcome_desc',
      status: 'active',
      skippable: true,
      actionLabel: 'setup.next',
    });
  }

  private emitCliSelect(): void {
    this.emit({
      stepId: 'cli-select',
      title: 'setup.cli_title',
      description: 'setup.cli_desc',
      options: CLI_TOOLS.map((cli) => ({
        id: `cli-${cli.id}`,
        label: cli.name,
        description: cli.free ? '(free)' : '',
        color: cli.color,
        badge: cli.free ? 'FREE' : undefined,
        selected: this.selectedClis.has(cli.id),
      })),
      multiSelect: true,
      status: 'active',
      skippable: true,
      showBack: this.mode === 'full',
      actionLabel: 'setup.cli_install_all',
    });
  }

  private async runCliInstall(): Promise<void> {
    const blockId = this.emit({
      stepId: 'cli-install',
      title: 'setup.cli_installing',
      logLines: [],
      status: 'active',
      skippable: true,
    });

    const logs: string[] = [];
    const appendLog = (line: string) => {
      logs.push(line);
      this.updateBlock(blockId, { logLines: [...logs] });
    };

    // Check npm availability
    appendLog('$ which npm');
    const npmCheck = await execCommand('which npm 2>&1');
    if (npmCheck.exitCode !== 0) {
      appendLog('→ npm not found');
      appendLog('');
      appendLog('PATH=' + (await execCommand('echo $PATH')).stdout.trim());
      this.updateBlock(blockId, {
        status: 'error',
        errorMessage: 'setup.path_error',
      });
      return;
    }
    appendLog('→ ' + npmCheck.stdout.trim());

    let hasError = false;

    for (const cliId of this.selectedClis) {
      const cli = CLI_TOOLS.find((c) => c.id === cliId);
      if (!cli) continue;

      // Check if already installed
      appendLog(`$ which ${cli.bin}`);
      const check = await execCommand(`which ${cli.bin} 2>/dev/null`);
      if (check.exitCode === 0 && check.stdout.trim()) {
        appendLog(`→ ${check.stdout.trim()} (already installed)`);
        continue;
      }
      appendLog('→ not found, installing...');

      // Install
      appendLog(`$ npm install -g ${cli.npm}`);
      try {
        const result = await execCommand(`npm install -g ${cli.npm} 2>&1`, 300000);
        if (result.exitCode === 0) {
          appendLog('→ installed successfully');
        } else {
          const err = (result.stderr || result.stdout || 'unknown error').slice(0, 200);
          appendLog(`→ FAILED (exit ${result.exitCode}): ${err}`);
          hasError = true;
        }
      } catch (e: any) {
        appendLog(`→ ERROR: ${e.message || e}`);
        hasError = true;
      }
    }

    if (hasError) {
      this.updateBlock(blockId, { status: 'error', errorMessage: 'Some installations failed' });
    } else {
      appendLog('');
      appendLog('✓ All tools installed');
      this.updateBlock(blockId, { status: 'completed' });
      // Move to auth
      setTimeout(() => this.emitCliAuth(), 500);
    }
  }

  private emitCliAuth(): void {
    const installed = Array.from(this.selectedClis);
    this.emit({
      stepId: 'cli-auth',
      title: 'setup.auth_title',
      description: 'setup.auth_desc',
      options: installed.map((id) => {
        const cli = CLI_TOOLS.find((c) => c.id === id);
        return {
          id: `auth-${id}`,
          label: cli?.name || id,
          color: cli?.color || '#666',
          description: 'setup.auth_browser',
        };
      }),
      status: 'active',
      skippable: true,
      actionLabel: 'setup.done',
    });
  }

  private async startBrowserAuth(toolId: AuthToolId, blockId: string): Promise<void> {
    const { AUTH_TOOL_CONFIGS } = require('@/lib/cli-auth');
    const config = AUTH_TOOL_CONFIGS.find((c: any) => c.id === toolId);
    if (!config) return;

    if (config.apiKeyUrl) {
      try {
        await Linking.openURL(config.apiKeyUrl);
      } catch (e) {
        logError('SetupFlow', 'Failed to open URL', e);
      }
    }
  }

  private async emitGitConfig(): Promise<void> {
    // Check existing git config
    const nameResult = await execCommand('git config --global user.name 2>/dev/null');
    const emailResult = await execCommand('git config --global user.email 2>/dev/null');
    const name = nameResult.stdout.trim();
    const email = emailResult.stdout.trim();

    if (name && email) {
      // Already configured — show and move on
      const blockId = this.emit({
        stepId: 'git-config',
        title: 'setup.git_title',
        description: 'setup.git_already',
        logLines: [`user.name = ${name}`, `user.email = ${email}`],
        status: 'completed',
        skippable: true,
      });
      // Auto-advance
      setTimeout(() => {
        if (this.mode === 'full') {
          this.emitGitSsh();
        } else {
          this.emitDone();
        }
      }, 300);
      return;
    }

    // Need input
    this.emit({
      stepId: 'git-input',
      title: 'setup.git_title',
      description: 'setup.git_desc',
      inputs: [
        { key: 'git-name', label: 'setup.git_name', placeholder: 'setup.git_name_placeholder', value: name || '' },
        { key: 'git-email', label: 'setup.git_email', placeholder: 'setup.git_email_placeholder', value: email || '' },
      ],
      status: 'active',
      skippable: true,
      actionLabel: 'setup.git_save',
    });
  }

  private emitGitSsh(): void {
    this.emit({
      stepId: 'git-ssh',
      title: 'setup.git_ssh_prompt',
      options: [
        { id: 'ssh-yes', label: 'setup.git_ssh_yes', color: '#4ADE80' },
        { id: 'ssh-no', label: 'setup.git_ssh_no', color: '#6B7280' },
      ],
      status: 'active',
      skippable: true,
    });
  }

  private async generateSshKey(): Promise<void> {
    const blockId = this.emit({
      stepId: 'git-ssh',
      title: 'setup.git_ssh_prompt',
      logLines: ['$ ssh-keygen -t ed25519 -C "shelly" -f ~/.ssh/id_ed25519 -N ""'],
      status: 'active',
      skippable: false,
    });

    try {
      await execCommand('mkdir -p ~/.ssh');
      const result = await execCommand('ssh-keygen -t ed25519 -C "shelly" -f ~/.ssh/id_ed25519 -N "" 2>&1');
      const pubKey = await execCommand('cat ~/.ssh/id_ed25519.pub');

      if (result.exitCode === 0 && pubKey.stdout.trim()) {
        this.updateBlock(blockId, {
          status: 'completed',
          logLines: [
            '$ ssh-keygen -t ed25519 -C "shelly" -f ~/.ssh/id_ed25519 -N ""',
            '✓ SSH key generated',
            '',
            'Public key (copy this to GitHub):',
            pubKey.stdout.trim(),
          ],
        });
      } else {
        this.updateBlock(blockId, {
          status: 'error',
          errorMessage: result.stderr || 'SSH key generation failed',
        });
      }
    } catch (e: any) {
      this.updateBlock(blockId, {
        status: 'error',
        errorMessage: e.message || 'SSH key generation failed',
      });
    }

    // Auto-advance after delay
    setTimeout(() => {
      if (this.mode === 'full') {
        this.emitProjectScan();
      } else {
        this.emitDone();
      }
    }, 1000);
  }

  private async emitProjectScan(): Promise<void> {
    const blockId = this.emit({
      stepId: 'project-scan',
      title: 'setup.project_title',
      description: 'setup.project_desc',
      logLines: ['Scanning ~/...'],
      status: 'active',
      skippable: true,
      actionLabel: 'setup.project_register',
    });

    try {
      const result = await execCommand(
        'ls -d ~/*/  2>/dev/null | head -20',
      );
      if (result.exitCode === 0 && result.stdout.trim()) {
        const dirs = result.stdout.trim().split('\n').filter(Boolean);
        // Filter to likely project folders (has .git, package.json, etc.)
        const projectDirs: string[] = [];
        for (const dir of dirs) {
          const trimmed = dir.replace(/\/$/, '');
          const check = await execCommand(
            `test -d "${trimmed}/.git" -o -f "${trimmed}/package.json" -o -f "${trimmed}/Cargo.toml" -o -f "${trimmed}/go.mod" -o -f "${trimmed}/pyproject.toml" && echo yes || echo no`,
          );
          if (check.stdout.trim() === 'yes') {
            projectDirs.push(trimmed);
          }
        }

        if (projectDirs.length > 0) {
          this.updateBlock(blockId, {
            options: projectDirs.map((dir) => ({
              id: dir,
              label: dir.replace(/^.*\//, ''),
              description: dir,
              selected: true,
            })),
            multiSelect: true,
            logLines: [`Found ${projectDirs.length} project folder(s)`],
          });
        } else {
          this.updateBlock(blockId, {
            logLines: ['No project folders found in ~/'],
            status: 'completed',
          });
          setTimeout(() => this.emitDone(), 300);
        }
      } else {
        this.updateBlock(blockId, {
          logLines: ['No folders found in ~/'],
          status: 'completed',
        });
        setTimeout(() => this.emitDone(), 300);
      }
    } catch (e: any) {
      this.updateBlock(blockId, {
        status: 'error',
        errorMessage: e.message || 'Scan failed',
      });
    }
  }

  /** Register selected project folders to sidebar */
  async registerProjects(paths: string[]): Promise<void> {
    try {
      const { useSidebarStore } = require('@/store/sidebar-store');
      const sidebar = useSidebarStore.getState();
      for (const path of paths) {
        sidebar.addRepo(path);
      }
      logInfo('SetupFlow', `Registered ${paths.length} project folders`);
    } catch (e) {
      logError('SetupFlow', 'Failed to register projects', e);
    }
  }

  private async emitDone(): Promise<void> {
    this.emit({
      stepId: 'done',
      title: 'setup.done_title',
      description: 'setup.done_desc',
      status: 'active',
      skippable: false,
      actionLabel: 'setup.done_start',
    });
  }
}

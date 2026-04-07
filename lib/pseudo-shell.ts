import { OutputLine } from '@/store/types';
import {
  saveWorkflow,
  loadWorkflow,
  listWorkflows,
  deleteWorkflow,
  substituteParams,
} from '@/lib/workflow-manager';
import { useSettingsStore, DEFAULT_SETTINGS } from '@/store/settings-store';
import { useCosmeticStore } from '@/store/cosmetic-store';

type ShellState = {
  cwd: string;
  env: Record<string, string>;
  history: string[];
};

const FAKE_FS: Record<string, string[]> = {
  '/': ['home', 'usr', 'etc', 'var', 'tmp', 'bin', 'lib', 'dev'],
  '/home': ['user'],
  '/home/user': ['Documents', 'Downloads', 'Projects', '.bashrc', '.zshrc', 'README.md'],
  '/home/user/Documents': ['notes.txt', 'todo.md', 'report.pdf'],
  '/home/user/Downloads': ['archive.zip', 'image.png', 'setup.sh'],
  '/home/user/Projects': ['shelly-app', 'my-website', 'scripts'],
  '/home/user/Projects/shelly-app': ['src', 'package.json', 'README.md', 'tsconfig.json'],
  '/home/user/Projects/my-website': ['index.html', 'styles.css', 'app.js'],
  '/home/user/Projects/scripts': ['deploy.sh', 'backup.sh', 'cleanup.sh'],
};

const FILE_CONTENTS: Record<string, string> = {
  '/home/user/.bashrc': `# .bashrc
export PATH="$HOME/.local/bin:$PATH"
alias ll='ls -la'
alias la='ls -A'
alias l='ls -CF'
PS1='\\u@\\h:\\w\\$ '`,
  '/home/user/.zshrc': `# .zshrc
export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME="robbyrussell"
plugins=(git node npm)
source $ZSH/oh-my-zsh.sh`,
  '/home/user/README.md': `# Welcome to Shelly Terminal

This is a prototype terminal app for Android.

## Features
- Japanese IME support
- Command block history
- Shortcut bar (Ctrl/Esc/Tab/arrows)
- Tab/session management

## Usage
Type commands and press Send to execute.`,
  '/home/user/Documents/notes.txt': `Meeting notes - 2026/02/25
- Reviewed terminal app prototype
- Discussed Z Fold6 compatibility
- Next: implement SSH support`,
  '/home/user/Documents/todo.md': `# TODO
- [x] Setup project
- [ ] Implement SSH
- [ ] Add themes
- [ ] Publish to Play Store`,
};

function resolvePath(cwd: string, path: string): string {
  if (!path || path === '.') return cwd;
  if (path.startsWith('/')) return normalizePath(path);
  if (path === '..') {
    const parts = cwd.split('/').filter(Boolean);
    parts.pop();
    return '/' + parts.join('/') || '/';
  }
  if (path.startsWith('../')) {
    const parts = cwd.split('/').filter(Boolean);
    parts.pop();
    const base = '/' + parts.join('/');
    return resolvePath(base, path.slice(3));
  }
  return normalizePath(cwd === '/' ? `/${path}` : `${cwd}/${path}`);
}

function normalizePath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') resolved.pop();
    else if (part !== '.') resolved.push(part);
  }
  return '/' + resolved.join('/') || '/';
}

function getEntries(path: string): string[] | null {
  return FAKE_FS[path] ?? null;
}

function isFile(path: string): boolean {
  return path in FILE_CONTENTS;
}

function isDir(path: string): boolean {
  return path in FAKE_FS;
}

export async function executeCommand(
  rawInput: string,
  state: ShellState
): Promise<{ lines: OutputLine[]; newState: Partial<ShellState> }> {
  const trimmed = rawInput.trim();
  if (!trimmed) return { lines: [], newState: {} };

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  const out = (...texts: string[]): OutputLine[] =>
    texts.map((t) => ({ text: t, type: 'stdout' as const }));
  const err = (text: string): OutputLine[] => [{ text, type: 'stderr' as const }];
  const info = (text: string): OutputLine[] => [{ text, type: 'info' as const }];

  switch (cmd) {
    case 'ls': {
      // Separate flags from path arguments
      const flags = args.filter((a) => a.startsWith('-')).join('');
      const pathArgs = args.filter((a) => !a.startsWith('-'));
      const target = pathArgs[0] ? resolvePath(state.cwd, pathArgs[0]) : state.cwd;
      const entries = getEntries(target);
      if (!entries) return { lines: err(`ls: cannot access '${pathArgs[0] || target}': No such file or directory`), newState: {} };
      const showAll = flags.includes('a');
      const longFormat = flags.includes('l');
      let list = [...entries];
      if (showAll) list = ['.', '..', ...list];
      if (longFormat) {
        const now = new Date();
        const dateStr = `${now.toLocaleString('en', { month: 'short' })} ${String(now.getDate()).padStart(2)}`;
        const lines = list.map((name) => {
          const fullPath = target === '/' ? `/${name}` : `${target}/${name}`;
          const isDirectory = isDir(fullPath);
          const perm = isDirectory ? 'drwxr-xr-x' : '-rw-r--r--';
          const size = isDirectory ? '4096' : String(Math.floor(Math.random() * 8192) + 100);
          return `${perm}  1 user user ${size.padStart(6)} ${dateStr} ${name}`;
        });
        return { lines: out(...lines), newState: {} };
      }
      return { lines: out(list.join('  ')), newState: {} };
    }

    case 'cd': {
      const target = args[0] ? resolvePath(state.cwd, args[0]) : '/home/user';
      if (!isDir(target)) return { lines: err(`cd: ${args[0] || target}: No such file or directory`), newState: {} };
      return { lines: [], newState: { cwd: target } };
    }

    case 'pwd':
      return { lines: out(state.cwd), newState: {} };

    case 'echo': {
      const text = args.join(' ').replace(/\$HOME/g, '/home/user').replace(/\$PWD/g, state.cwd).replace(/\$USER/g, 'user');
      return { lines: out(text), newState: {} };
    }

    case 'cat': {
      if (!args[0]) return { lines: err('cat: missing operand'), newState: {} };
      const target = resolvePath(state.cwd, args[0]);
      if (isDir(target)) return { lines: err(`cat: ${args[0]}: Is a directory`), newState: {} };
      const content = FILE_CONTENTS[target];
      if (!content) return { lines: err(`cat: ${args[0]}: No such file or directory`), newState: {} };
      return { lines: out(...content.split('\n')), newState: {} };
    }

    case 'mkdir': {
      if (!args[0]) return { lines: err('mkdir: missing operand'), newState: {} };
      return { lines: info(`mkdir: created directory '${args[0]}'`), newState: {} };
    }

    case 'touch': {
      if (!args[0]) return { lines: err('touch: missing file operand'), newState: {} };
      return { lines: [], newState: {} };
    }

    case 'rm': {
      if (!args[0]) return { lines: err('rm: missing operand'), newState: {} };
      const target = args.find((a) => !a.startsWith('-')) || '';
      return { lines: info(`Removed: ${target}`), newState: {} };
    }

    case 'cp': {
      if (args.length < 2) return { lines: err('cp: missing destination file operand'), newState: {} };
      return { lines: [], newState: {} };
    }

    case 'mv': {
      if (args.length < 2) return { lines: err('mv: missing destination file operand'), newState: {} };
      return { lines: [], newState: {} };
    }

    case 'grep': {
      if (args.length < 2) return { lines: err('grep: usage: grep PATTERN FILE'), newState: {} };
      const pattern = args[0];
      const file = resolvePath(state.cwd, args[1]);
      const content = FILE_CONTENTS[file];
      if (!content) return { lines: err(`grep: ${args[1]}: No such file or directory`), newState: {} };
      const matches = content.split('\n').filter((l) => l.includes(pattern));
      if (matches.length === 0) return { lines: [], newState: {} };
      return { lines: out(...matches), newState: {} };
    }

    case 'find': {
      const base = args[0] ? resolvePath(state.cwd, args[0]) : state.cwd;
      const results = Object.keys(FAKE_FS)
        .filter((p) => p.startsWith(base))
        .flatMap((p) => [p, ...(FAKE_FS[p] || []).map((e) => `${p === '/' ? '' : p}/${e}`)]);
      return { lines: out(...results.slice(0, 20)), newState: {} };
    }

    case 'which': {
      const cmds: Record<string, string> = {
        ls: '/bin/ls', cd: '/bin/cd', pwd: '/bin/pwd', echo: '/bin/echo',
        cat: '/bin/cat', grep: '/bin/grep', find: '/usr/bin/find',
        node: '/usr/local/bin/node', npm: '/usr/local/bin/npm',
        git: '/usr/bin/git', python3: '/usr/bin/python3',
      };
      const found = cmds[args[0]];
      if (!found) return { lines: err(`${args[0]} not found`), newState: {} };
      return { lines: out(found), newState: {} };
    }

    case 'whoami':
      return { lines: out('user'), newState: {} };

    case 'hostname':
      return { lines: out('shelly-android'), newState: {} };

    case 'uname': {
      if (args.includes('-a')) {
        return { lines: out('Linux shelly-android 6.1.0-android #1 SMP PREEMPT Android aarch64 GNU/Linux'), newState: {} };
      }
      return { lines: out('Linux'), newState: {} };
    }

    case 'date':
      return { lines: out(new Date().toString()), newState: {} };

    case 'env':
      return {
        lines: out(
          'HOME=/home/user',
          'USER=user',
          'SHELL=/bin/zsh',
          `PWD=${state.cwd}`,
          'TERM=xterm-256color',
          'LANG=ja_JP.UTF-8',
          'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
        ),
        newState: {},
      };

    case 'export': {
      if (!args[0]) return { lines: [], newState: {} };
      const [key, val] = args[0].split('=');
      return { lines: [], newState: { env: { ...state.env, [key]: val || '' } } };
    }

    case 'history': {
      const lines = state.history.map((cmd, i) => `  ${String(i + 1).padStart(3)}  ${cmd}`);
      return { lines: out(...lines), newState: {} };
    }

    case 'clear':
      return { lines: [{ text: '__CLEAR__', type: 'info' }], newState: {} };

    case 'git': {
      if (!args[0]) return { lines: out('usage: git [--version] [--help] <command> [<args>]'), newState: {} };
      switch (args[0]) {
        case 'status':
          return {
            lines: out(
              'On branch main',
              "Your branch is up to date with 'origin/main'.",
              '',
              'nothing to commit, working tree clean'
            ),
            newState: {},
          };
        case 'log':
          return {
            lines: out(
              'commit a1b2c3d4e5f6 (HEAD -> main, origin/main)',
              'Author: User <user@example.com>',
              `Date:   ${new Date().toDateString()}`,
              '',
              '    Initial commit',
              '',
              'commit 9f8e7d6c5b4a',
              'Author: User <user@example.com>',
              'Date:   Mon Feb 24 10:00:00 2026',
              '',
              '    Add README'
            ),
            newState: {},
          };
        case 'branch':
          return { lines: out('* main', '  develop', '  feature/terminal-ui'), newState: {} };
        case 'diff':
          return { lines: out('(no changes)'), newState: {} };
        default:
          return { lines: out(`git: '${args[0]}' is not a git command. See 'git --help'.`), newState: {} };
      }
    }

    case 'node': {
      if (!args[0]) return { lines: out('Welcome to Node.js v22.13.0.\nType ".exit" to exit.'), newState: {} };
      if (args[0] === '--version' || args[0] === '-v') return { lines: out('v22.13.0'), newState: {} };
      return { lines: out('[Node.js REPL not available in prototype]'), newState: {} };
    }

    case 'npm': {
      if (args[0] === '--version' || args[0] === '-v') return { lines: out('10.9.2'), newState: {} };
      if (args[0] === 'list' || args[0] === 'ls') {
        return { lines: out('shelly-app@1.0.0', '├── react@19.1.0', '├── react-native@0.81.5', '└── expo@54.0.29'), newState: {} };
      }
      return { lines: out(`npm: '${args[0]}' command executed (prototype)`), newState: {} };
    }

    case 'python3': {
      if (args[0] === '--version' || args[0] === '-V') return { lines: out('Python 3.11.0'), newState: {} };
      return { lines: out('[Python REPL not available in prototype]'), newState: {} };
    }

    case 'ping': {
      const host = args[0] || 'localhost';
      return {
        lines: out(
          `PING ${host}: 56 data bytes`,
          `64 bytes from ${host}: icmp_seq=0 ttl=64 time=0.123 ms`,
          `64 bytes from ${host}: icmp_seq=1 ttl=64 time=0.098 ms`,
          `64 bytes from ${host}: icmp_seq=2 ttl=64 time=0.112 ms`,
          `--- ${host} ping statistics ---`,
          '3 packets transmitted, 3 received, 0% packet loss'
        ),
        newState: {},
      };
    }

    case 'curl': {
      const url = args.find((a) => !a.startsWith('-')) || '';
      return { lines: out(`[curl] Fetching ${url}...`, '{"status":"ok","message":"Prototype response"}'), newState: {} };
    }

    case 'ssh': {
      const host = args[0] || 'remote-host';
      return {
        lines: [
          { text: `[SSH] Connecting to ${host}...`, type: 'info' },
          { text: '[SSH] Real SSH not available in prototype. Use Settings > SSH to configure.', type: 'stderr' },
        ],
        newState: {},
      };
    }

    case 'man': {
      const topic = args[0] || '';
      return {
        lines: out(
          `MAN: ${topic}`,
          '─────────────────────────────────',
          `NAME: ${topic} - command description`,
          'SYNOPSIS: see --help for usage',
          '[Full man pages not available in prototype]'
        ),
        newState: {},
      };
    }

    case 'help':
    case '--help': {
      return {
        lines: out(
          'Shelly Terminal - Available Commands',
          '════════════════════════════════════',
          'File System:  ls, cd, pwd, mkdir, touch, rm, cp, mv, cat, find',
          'Text:         echo, grep, cat',
          'System:       whoami, hostname, uname, date, env, export, history, clear',
          'Development:  git, node, npm, python3',
          'Network:      ping, curl, ssh',
          'Other:        which, man, help',
          '',
          'Tip: Use ↑/↓ in shortcut bar to navigate command history'
        ),
        newState: {},
      };
    }

    case 'shelly': {
      const sub = args[0];

      // ── shelly config ────────────────────────────────────────────────────────
      if (sub === 'config') {
        const configSub = args[1];

        // shelly config (no args) → open TUI overlay
        if (!configSub) {
          useSettingsStore.getState().setShowConfigTUI(true);
          return { lines: info('Opening settings…'), newState: {} };
        }

        // shelly config list → print all settings as key=value
        if (configSub === 'list') {
          const { settings } = useSettingsStore.getState();
          const cosmetics = useCosmeticStore.getState();
          const configMap: Record<string, unknown> = {
            fontSize:                settings.fontSize,
            cursorShape:             settings.cursorShape,
            hapticFeedback:          settings.hapticFeedback,
            autoScroll:              settings.autoScroll,
            soundEffects:            settings.soundEffects,
            localLlmEnabled:         settings.localLlmEnabled,
            localLlmUrl:             settings.localLlmUrl,
            localLlmModel:           settings.localLlmModel,
            crtEnabled:              cosmetics.crtEnabled,
            crtIntensity:            cosmetics.crtIntensity,
            soundProfile:            cosmetics.soundProfile,
            fontFamily:              cosmetics.fontFamily,
            autocomplete:            (settings as Record<string, unknown>)['autocomplete'] ?? false,
            syntaxHighlight:         (settings as Record<string, unknown>)['syntaxHighlight'] ?? false,
            highContrastOutput:      settings.highContrastOutput,
            enableCommandSafety:     settings.enableCommandSafety,
            llmInterpreterEnabled:   settings.llmInterpreterEnabled,
            realtimeTranslateEnabled:settings.realtimeTranslateEnabled,
            gpuRendering:            settings.gpuRendering,
          };
          const rows = Object.entries(configMap).map(([k, v]) => `${k}=${v}`);
          return { lines: out(...rows), newState: {} };
        }

        // shelly config get <key>
        if (configSub === 'get') {
          const key = args[2];
          if (!key) return { lines: err('Usage: shelly config get <key>'), newState: {} };
          const { settings } = useSettingsStore.getState();
          const cosmetics = useCosmeticStore.getState();
          const combined: Record<string, unknown> = {
            ...(settings as Record<string, unknown>),
            crtEnabled: cosmetics.crtEnabled,
            crtIntensity: cosmetics.crtIntensity,
            soundProfile: cosmetics.soundProfile,
            fontFamily: cosmetics.fontFamily,
          };
          if (!(key in combined)) return { lines: err(`config: unknown key '${key}'`), newState: {} };
          return { lines: out(`${key}=${combined[key]}`), newState: {} };
        }

        // shelly config set <key> <value>
        if (configSub === 'set') {
          const key = args[2];
          const rawVal = args[3];
          if (!key || rawVal === undefined) {
            return { lines: err('Usage: shelly config set <key> <value>'), newState: {} };
          }

          // Cosmetic keys
          const COSMETIC_KEYS: Record<string, (v: string) => void> = {
            crtEnabled:   (v) => useCosmeticStore.getState().setCrt(v === 'true' || v === '1'),
            crtIntensity: (v) => useCosmeticStore.getState().setCrtIntensity(Number(v)),
            soundProfile: (v) => useCosmeticStore.getState().setSoundProfile(v as import('@/store/cosmetic-store').SoundProfile),
            fontFamily:   (v) => useCosmeticStore.getState().setFontFamily(v as import('@/store/cosmetic-store').FontFamily),
          };

          if (key in COSMETIC_KEYS) {
            COSMETIC_KEYS[key](rawVal);
            return { lines: out(`${key} = ${rawVal}`), newState: {} };
          }

          // Boolean settings
          const BOOL_KEYS = new Set([
            'hapticFeedback', 'autoScroll', 'soundEffects', 'localLlmEnabled',
            'highContrastOutput', 'enableCommandSafety', 'llmInterpreterEnabled',
            'realtimeTranslateEnabled', 'gpuRendering', 'autocomplete', 'syntaxHighlight',
          ]);
          if (BOOL_KEYS.has(key)) {
            const boolVal = rawVal === 'true' || rawVal === '1' || rawVal === 'on';
            useSettingsStore.getState().updateSettings({ [key]: boolVal });
            return { lines: out(`${key} = ${boolVal}`), newState: {} };
          }

          // Number settings
          const NUM_KEYS = new Set(['fontSize', 'soundVolume']);
          if (NUM_KEYS.has(key)) {
            const num = parseFloat(rawVal);
            if (isNaN(num)) return { lines: err(`config: '${rawVal}' is not a number`), newState: {} };
            useSettingsStore.getState().updateSettings({ [key]: num });
            return { lines: out(`${key} = ${num}`), newState: {} };
          }

          // String settings
          const STR_KEYS = new Set(['cursorShape', 'localLlmUrl', 'localLlmModel', 'terminalTheme', 'groqModel']);
          if (STR_KEYS.has(key)) {
            useSettingsStore.getState().updateSettings({ [key]: rawVal });
            return { lines: out(`${key} = ${rawVal}`), newState: {} };
          }

          return { lines: err(`config: unknown key '${key}'`), newState: {} };
        }

        return {
          lines: out(
            'Usage: shelly config [subcommand]',
            '',
            'Subcommands:',
            '  (none)           Open settings TUI',
            '  list             Print all settings as key=value',
            '  get <key>        Show a single setting value',
            '  set <key> <val>  Update a setting'
          ),
          newState: {},
        };
      }

      // ── shelly voice ─────────────────────────────────────────────────────────
      if (sub === 'voice') {
        useSettingsStore.getState().setShowVoiceMode(true);
        return { lines: info('Opening voice mode…'), newState: {} };
      }

      if (sub !== 'workflow') {
        return {
          lines: out(
            'Usage: shelly <command>',
            '',
            'Commands:',
            '  shelly config    View and edit settings',
            '  shelly voice     Open full-screen voice chat',
            '  shelly workflow  Manage saved workflows'
          ),
          newState: {},
        };
      }

      const wfSub = args[1];

      switch (wfSub) {
        case 'save': {
          const name = args[2];
          if (!name) return { lines: err('Usage: shelly workflow save <name>'), newState: {} };
          const recent = state.history.slice(0, 5);
          if (recent.length === 0) return { lines: err('No commands in session history to save'), newState: {} };
          await saveWorkflow(name, recent);
          return { lines: out(`Saved workflow '${name}' with ${recent.length} commands`), newState: {} };
        }

        case 'run': {
          const name = args[2];
          if (!name) return { lines: err('Usage: shelly workflow run <name> [args...]'), newState: {} };
          const wf = await loadWorkflow(name);
          if (!wf) return { lines: err(`Workflow '${name}' not found`), newState: {} };
          const params = args.slice(3);
          const cmds = substituteParams(wf.commands, params);
          return { lines: out(...cmds.map((c) => `$ ${c}`)), newState: {} };
        }

        case 'list': {
          const wfs = await listWorkflows();
          if (wfs.length === 0) return { lines: out('No workflows saved yet.'), newState: {} };
          const header = 'NAME                 COMMANDS';
          const sep   = '─────────────────────────────';
          const rows = wfs.map((w) => `${w.name.padEnd(20)} ${w.commands.length}`);
          return { lines: out(header, sep, ...rows), newState: {} };
        }

        case 'edit': {
          const name = args[2];
          if (!name) return { lines: err('Usage: shelly workflow edit <name>'), newState: {} };
          const wf = await loadWorkflow(name);
          if (!wf) return { lines: err(`Workflow '${name}' not found`), newState: {} };
          const lines = [
            `Workflow: ${name}`,
            '─────────────────────────────',
            ...wf.commands.map((c, i) => `  ${i + 1}. ${c}`),
            '',
            `Edit: vim ~/.shelly/workflows/${name}.sh`,
          ];
          return { lines: out(...lines), newState: {} };
        }

        case 'delete': {
          const name = args[2];
          if (!name) return { lines: err('Usage: shelly workflow delete <name>'), newState: {} };
          const ok = await deleteWorkflow(name);
          if (!ok) return { lines: err(`Failed to delete workflow '${name}'`), newState: {} };
          return { lines: out(`Deleted workflow '${name}'`), newState: {} };
        }

        default: {
          return {
            lines: out(
              'Usage: shelly workflow <subcommand>',
              '',
              'Subcommands:',
              '  save <name>           Save last 5 commands as a workflow',
              '  run  <name> [args...] Run a saved workflow',
              '  list                  List all workflows',
              '  edit <name>           Show workflow contents',
              '  delete <name>         Delete a workflow'
            ),
            newState: {},
          };
        }
      }
    }

    default: {
      // Check if it looks like a path execution
      if (cmd.startsWith('./') || cmd.startsWith('/')) {
        return { lines: err(`bash: ${cmd}: Permission denied`), newState: {} };
      }
      return { lines: err(`bash: ${cmd}: command not found`), newState: {} };
    }
  }
}

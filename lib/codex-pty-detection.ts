export type CodexPtyDetection = {
  cwd: string | null;
  reason: 'banner' | 'prompt';
};

const ANSI_ESCAPE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function detectCodexPtyLaunchText(output: string): CodexPtyDetection | null {
  const text = stripTerminalControl(output);
  const cwd = extractCodexCwd(text);
  if (cwd && /OpenAI\s+Codex/i.test(text)) {
    return { cwd, reason: 'banner' };
  }
  if (cwd && /\b(?:gpt|o\d|codex)[\w.-]*\b.*[·•]\s*\//i.test(text)) {
    return { cwd, reason: 'prompt' };
  }
  return null;
}

export function detectCodexActiveTranscript(output: string): boolean {
  const text = stripTerminalControl(output);
  const lines = text.split('\n').map((line) => line.trimEnd());
  let lastCodexPrompt = -1;
  let lastShellPrompt = -1;

  lines.forEach((line, index) => {
    if (isCodexPromptLine(line) || /OpenAI\s+Codex/i.test(line)) {
      lastCodexPrompt = index;
    } else if (isShellPromptLine(line)) {
      lastShellPrompt = index;
    }
  });

  return lastCodexPrompt >= 0 && lastCodexPrompt > lastShellPrompt;
}

export function detectCodexLaunchFailureText(output: string): boolean {
  const text = stripTerminalControl(output);
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const recentLines = lines.slice(-12);
  if (!recentLines.length) return false;

  let lastFailureLine = -1;
  let lastLiveCodexLine = -1;
  let hasNativeCrash = false;
  let hasCodexLauncher = false;
  recentLines.forEach((line, index) => {
    if (isCodexPromptLine(line) || /OpenAI\s+Codex/i.test(line)) {
      lastLiveCodexLine = index;
    }
    if (/\bcodex:\s+(?:launch failed|.*runtime.*(?:crashed|failed|exited))/i.test(line)) {
      lastFailureLine = index;
    }
    if (/\b(?:Bus error|Segmentation fault|Illegal instruction|Trace\/breakpoint trap|Aborted)\b/i.test(line)) {
      hasNativeCrash = true;
      lastFailureLine = index;
    }
    if (/\b(?:linker64|codex_tui|SHELLY_CODEX_EXEC_PATH|SHELLY_LD_LIBRARY_PATH|LD_LIBRARY_PATH)\b/i.test(line)) {
      hasCodexLauncher = true;
    }
  });
  if (lastFailureLine < 0) return false;
  if (lastLiveCodexLine > lastFailureLine) return false;
  return /\bcodex:\s+(?:launch failed|.*runtime.*(?:crashed|failed|exited))/i.test(recentLines[lastFailureLine] ?? '')
    || (hasNativeCrash && hasCodexLauncher);
}

export function detectCodexApprovalPrompt(output: string): boolean {
  const text = stripTerminalControl(output);
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const recentLines = lines.slice(-8);
  const tail = recentLines.join('\n');
  if (!tail) return false;
  const hasApprovalKeyword = /\b(?:approval|approve|permission|allow|deny)\b/i.test(tail);
  const hasChoice = recentLines.some((line) =>
    /\b(?:y\/n|yes\/no|allow|deny|approve|reject)\b/i.test(line)
      || /^\s*(?:[^A-Za-z0-9\s]\s*)?(?:\d+[\).]\s*)?(?:yes|no|y|n)\b(?:\s*[,):.-]|\s*$)/i.test(line)
  );
  return hasApprovalKeyword && hasChoice;
}

export function detectCodexInteractivePrompt(output: string): boolean {
  const text = stripTerminalControl(output);
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const recentLines = lines.slice(-12);
  const tail = recentLines.join('\n');
  if (!tail) return false;

  const hasInteractiveKeyword = /(?:Approaching rate limits|Switch to\b.*\bmodel\b|Keep current model|Would you like to make the following edits|Yes,\s*proceed|don't ask again|Press enter to confirm|esc to go back|rate limit reminders|select an option|choose an option)/i.test(tail);
  const numberedChoices = recentLines.filter((line) =>
    /^\s*(?:[\u003e\u203a\u276f]\s*)?\d+[\).]\s+\S/.test(line)
  ).length;
  const hasFocusedChoice = recentLines.some((line) =>
    /^\s*(?:[\u003e\u203a\u276f]\s*)\d+[\).]\s+\S/.test(line)
  );

  return hasInteractiveKeyword && (numberedChoices >= 2 || hasFocusedChoice);
}

export function detectShellReadyText(output: string): boolean {
  const text = stripTerminalControl(output);
  const lines = text.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  const lastLine = lines[lines.length - 1] ?? '';
  return isShellPromptLine(lastLine);
}

function extractCodexCwd(text: string): string | null {
  const directory = /(?:^|\n)\s*(?:directory|cwd)\s*:\s*(\/\S+)/i.exec(text)?.[1];
  if (directory) return normalizeDetectedPath(directory);

  const promptCwd = /(?:^|\n)[^\n]*\b(?:gpt|o\d|codex)[\w.-]*\b[^\n]*[·•]\s*(\/\S+)/i.exec(text)?.[1];
  if (promptCwd) return normalizeDetectedPath(promptCwd);

  return null;
}

function isCodexPromptLine(line: string): boolean {
  return /\b(?:gpt|o\d|codex)[\w.-]*\b.*[·•]\s*\//i.test(line);
}

function isShellPromptLine(line: string): boolean {
  return /^\s*(?:[~\w./:@+-]+\s*)?[$#]\s*$/.test(line);
}

function normalizeDetectedPath(path: string): string {
  return path
    .replace(/[.,;:)]+$/g, '')
    .trim();
}

function stripTerminalControl(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001bP[\s\S]*?\u001b\\/g, '')
    .replace(ANSI_ESCAPE, '')
    .replace(/\bR?(?:10|11|12);rgb:[0-9a-fA-F/]+(?:;[0-9:;]*)?/g, '')
    .replace(/\r/g, '\n');
}

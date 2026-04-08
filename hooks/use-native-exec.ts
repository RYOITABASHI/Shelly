/**
 * useNativeExec — Drop-in replacement for useTermuxBridge.
 *
 * Executes commands via TerminalEmulator.execCommand (JNI fork+exec+pipe)
 * instead of WebSocket bridge. Same interface so consumers can swap imports.
 */

import { useCallback } from 'react';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { logInfo, logError } from '@/lib/debug-logger';

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type RunCommandOptions = {
  cwd?: string;
  env?: Record<string, string>;
  onStream?: (type: 'stdout' | 'stderr', data: string) => void;
  timeoutMs?: number;
};

export type ReadFileResult =
  | { ok: true; content: string; encoding: string }
  | { ok: false; error: string };

export type ListFilesResult =
  | { ok: true; entries: { name: string; isDir: boolean; size: number }[]; dirPath: string; total: number }
  | { ok: false; error: string };

export type EditFileEdit = { oldText: string; newText: string };

export type EditFileResult =
  | { ok: true; filePath: string; editsApplied: number }
  | { ok: false; error: string };

export type WriteFileResult =
  | { ok: true }
  | { ok: false; error: string };

export async function execCommand(command: string, timeoutMs?: number): Promise<ExecResult> {
  logInfo('NativeExec', 'exec: ' + command.slice(0, 80));
  try {
    const result = await TerminalEmulator.execCommand(command, timeoutMs);
    logInfo('NativeExec', 'exit=' + result.exitCode + ' stdout=' + result.stdout.length + 'chars');
    return result;
  } catch (error: any) {
    logError('NativeExec', 'exec failed: ' + command.slice(0, 40), error);
    throw error;
  }
}

export function useNativeExec() {
  // ── Command execution ───────────────────────────────────────────────────

  const runCommand = useCallback(async (
    cmd: string,
    opts?: RunCommandOptions,
  ): Promise<ExecResult> => {
    const timeout = opts?.timeoutMs ?? 120_000;
    // If cwd specified, prepend cd
    const fullCmd = opts?.cwd ? `cd '${opts.cwd}' && ${cmd}` : cmd;
    return execCommand(fullCmd, timeout);
  }, []);

  const runRawCommand = useCallback(async (
    cmd: string,
    opts?: { onStream?: (type: 'stdout' | 'stderr', data: string) => void; timeoutMs?: number; reason?: string },
  ): Promise<ExecResult> => {
    const timeout = opts?.timeoutMs ?? 1_200_000; // 20 min default (same as old runRawCommand)
    return execCommand(cmd, timeout);
  }, []);

  // ── File operations ─────────────────────────────────────────────────────

  const writeFile = useCallback(async (
    filePath: string,
    content: string,
    _encoding?: string,
  ): Promise<WriteFileResult> => {
    try {
      // Use base64 to avoid shell escaping issues
      const base64Content = btoa(unescape(encodeURIComponent(content)));
      const result = await execCommand(
        `echo '${base64Content}' | base64 -d > '${filePath}'`,
        30_000,
      );
      return result.exitCode === 0
        ? { ok: true }
        : { ok: false, error: result.stderr || `exit code ${result.exitCode}` };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }, []);

  const readFile = useCallback(async (
    filePath: string,
    _encoding?: string,
  ): Promise<ReadFileResult> => {
    try {
      const result = await execCommand(`cat '${filePath}'`, 30_000);
      return result.exitCode === 0
        ? { ok: true, content: result.stdout, encoding: 'utf8' }
        : { ok: false, error: result.stderr || `exit code ${result.exitCode}` };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }, []);

  const listFiles = useCallback(async (
    dir?: string,
    _opts?: { showHidden?: boolean },
  ): Promise<ListFilesResult> => {
    try {
      const target = dir || '.';
      // JSON-style output for reliable parsing
      const result = await execCommand(
        `ls -la '${target}' 2>/dev/null | tail -n +2`,
        10_000,
      );
      if (result.exitCode !== 0) {
        return { ok: false, error: result.stderr || 'ls failed' };
      }
      const entries = result.stdout.trim().split('\n').filter(Boolean).map((line) => {
        const parts = line.split(/\s+/);
        const isDir = line.startsWith('d');
        const size = parseInt(parts[4] || '0', 10) || 0;
        const name = parts.slice(8).join(' ');
        return { name, isDir, size };
      });
      return { ok: true, entries, dirPath: target, total: entries.length };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }, []);

  const editFile = useCallback(async (
    filePath: string,
    edits: EditFileEdit[],
  ): Promise<EditFileResult> => {
    try {
      // Read file, apply edits in memory, write back
      const readResult = await execCommand(`cat '${filePath}'`, 30_000);
      if (readResult.exitCode !== 0) {
        return { ok: false, error: readResult.stderr || 'Cannot read file' };
      }

      let content = readResult.stdout;
      let applied = 0;
      for (const edit of edits) {
        if (content.includes(edit.oldText)) {
          content = content.replace(edit.oldText, edit.newText);
          applied++;
        }
      }

      const writeResult = await writeFile(filePath, content);
      if (!writeResult.ok) {
        return { ok: false, error: writeResult.error };
      }
      return { ok: true, filePath, editsApplied: applied };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }, [writeFile]);

  // ── Status (always "connected" in native mode) ─────────────────────────

  return {
    runCommand,
    runRawCommand,
    writeFile,
    readFile,
    listFiles,
    editFile,
    isConnected: true,
    testConnection: useCallback(async () => true, []),
  };
}

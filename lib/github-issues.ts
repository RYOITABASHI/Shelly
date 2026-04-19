/**
 * lib/github-issues.ts
 *
 * Create GitHub issues against RYOITABASHI/Shelly using the shelly-cs
 * OAuth token already persisted on disk by `shelly-cs auth`. Used by
 * the Ask Pane Stage 2 flow: when an AI answer is tagged
 * [NOT_AVAILABLE], the user can file an issue with one tap — we fill
 * in the question + the AI's explanation + environment info.
 *
 * Token access path:
 *   $HOME/.shelly-cs/token    (0600, written by shelly-cs.js cmdAuth)
 *
 * We deliberately avoid a JSI bridge for Stage 2 — expo-file-system
 * reads the token file directly. This means:
 *   - Zero native changes.
 *   - Token stays in a file rather than SecureStore. That's good
 *     enough for MVP; a SecureStore bridge is tracked separately.
 *   - If the user hasn't run `shelly-cs auth`, the file is missing and
 *     we surface an inline hint in the UI.
 */

import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import { initHomePath, getHomePath } from '@/lib/home-path';
import { execCommand } from '@/hooks/use-native-exec';
import { logInfo, logError } from '@/lib/debug-logger';

/** Where shelly-cs persists the OAuth user-access token. */
export const SHELLY_CS_TOKEN_PATH = '.shelly-cs/token';

/** Target repo for auto-filed issues (overridable via env for dev forks). */
export const ISSUE_REPO_DEFAULT = 'RYOITABASHI/Shelly';

/** Label applied to every issue filed via Ask Pane. */
export const ASK_PANE_LABEL = 'from-ask-pane';

// ─────────────────────────────────────────────────────────────
// Token access
// ─────────────────────────────────────────────────────────────

export async function readShellyCSToken(): Promise<string | null> {
  // Try expo-file-system first. In Expo SDK 52+ the scoping is relaxed
  // for any path under documentDirectory, which on Shelly IS the
  // directory containing ~/.shelly-cs/. If the API surface changes or
  // the path resolves to the symlink form (/data/data/...), fall
  // through to the JNI execCommand bridge we know works.
  try {
    await initHomePath();
    const home = getHomePath();
    if (home) {
      const uri = `file://${home}/${SHELLY_CS_TOKEN_PATH}`;
      const info = await FileSystem.getInfoAsync(uri);
      if (info.exists) {
        const raw = await FileSystem.readAsStringAsync(uri);
        const token = raw.trim();
        if (token.length > 0) {
          logInfo('github-issues', 'token read via FileSystem');
          return token;
        }
      }
    }
  } catch (e) {
    logError('github-issues', 'FileSystem read failed, falling back to execCommand', e);
  }

  // Fallback: shell out via the JNI execCommand bridge. shelly-cs wrote
  // the file from its own bundled node process; reading it back through
  // bash works because both processes share the app UID and the file is
  // 0600. This path is strictly more reliable than expo-file-system on
  // older SDK versions or if the app's documentDirectory resolver
  // disagrees with the native getHomeDir() result.
  try {
    const r = await execCommand('cat "$HOME/.shelly-cs/token" 2>/dev/null', 5000);
    const token = r.stdout.trim();
    if (r.exitCode === 0 && token.length > 0) {
      logInfo('github-issues', 'token read via execCommand');
      return token;
    }
  } catch (e) {
    logError('github-issues', 'execCommand read failed', e);
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// Draft builder
// ─────────────────────────────────────────────────────────────

export type IssueDraft = {
  title: string;
  body: string;
  labels: string[];
};

type DraftInput = {
  question: string;
  answer: string;
  shellyVersion?: string;
  bashrcVersion?: string;
};

function truncate(s: string, n: number): string {
  const trimmed = s.trim();
  return trimmed.length <= n ? trimmed : (trimmed.slice(0, n - 1).trimEnd() + '…');
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Build a preview-ready issue draft from the user's question + AI answer.
 * Both title and body are editable before submit — this is just the
 * starting point.
 */
export function buildDraft(input: DraftInput): IssueDraft {
  const q = input.question.trim();
  const title = `[Ask Pane] ${truncate(q, 72)}`;

  const shellyVersion = input.shellyVersion ?? '(unknown)';
  const bashrcVersion = input.bashrcVersion ?? '(unknown)';

  const body = [
    '### Context',
    `The user asked Ask Pane:`,
    `> ${q.split('\n').join('\n> ')}`,
    '',
    '### AI response',
    input.answer.trim(),
    '',
    '### Environment',
    `- Shelly version: ${shellyVersion}`,
    `- Platform: ${Platform.OS} ${Platform.Version}`,
    `- BASHRC_VERSION: ${bashrcVersion}`,
    '',
    '---',
    `Filed via Shelly Ask Pane on ${timestamp()}.`,
  ].join('\n');

  return { title, body, labels: [ASK_PANE_LABEL] };
}

// ─────────────────────────────────────────────────────────────
// REST POST
// ─────────────────────────────────────────────────────────────

export type CreateIssueResult =
  | { ok: true; number: number; html_url: string }
  | { ok: false; error: string; needsAuth?: boolean };

/**
 * POST the draft to /repos/{repo}/issues. Returns a tagged result so
 * the caller can distinguish "needs re-auth" from "invalid title" from
 * network failures.
 */
export async function createIssue(draft: IssueDraft, repo: string = ISSUE_REPO_DEFAULT): Promise<CreateIssueResult> {
  const token = await readShellyCSToken();
  if (!token) {
    return {
      ok: false,
      error: 'Not authenticated. Run `shelly-cs auth` in a terminal first.',
      needsAuth: true,
    };
  }

  const url = `https://api.github.com/repos/${repo}/issues`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'shelly-ask/0.1 (+https://github.com/RYOITABASHI/Shelly)',
      },
      body: JSON.stringify({
        title: draft.title,
        body: draft.body,
        labels: draft.labels,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '<no body>');
      let msg: string;
      try {
        msg = JSON.parse(text).message || text;
      } catch {
        msg = text;
      }
      if (res.status === 401) {
        return { ok: false, error: 'Session expired. Run `shelly-cs auth` again.', needsAuth: true };
      }
      if (res.status === 403) {
        return { ok: false, error: `GitHub rate-limited or forbidden: ${msg}` };
      }
      return { ok: false, error: `GitHub API ${res.status}: ${msg}` };
    }

    const json = await res.json();
    logInfo('github-issues', `created issue #${json.number}: ${json.html_url}`);
    return { ok: true, number: json.number, html_url: json.html_url };
  } catch (e: any) {
    logError('github-issues', 'POST failed', e);
    return { ok: false, error: e?.message || 'Network error' };
  }
}

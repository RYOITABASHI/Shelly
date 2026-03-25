/**
 * lib/github-push.ts — GitHub push operations.
 *
 * Creates repos via the GitHub API and pushes via git CLI.
 * All directory paths are shell-escaped. PATs are never logged.
 */

import { shellEscape } from '@/lib/auto-savepoint';

type RunCommandFn = (cmd: string) => Promise<{ stdout: string; exitCode: number | null }>;

/**
 * Create a new GitHub repo and push the local project to it.
 */
export async function createAndPushRepo(params: {
  projectDir: string;
  repoName: string;
  isPrivate: boolean;
  pat: string;
  username: string;
  runCommand: RunCommandFn;
}): Promise<{ success: boolean; url?: string; error?: string }> {
  const { projectDir, repoName, isPrivate, pat, username, runCommand } = params;
  const dir = shellEscape(projectDir);

  try {
    // 1. Create repo via API
    const res = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: repoName,
        private: isPrivate,
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body?.errors?.[0]?.message || body?.message || `HTTP ${res.status}`;
      return { success: false, error: msg };
    }

    const repoData = await res.json();
    const repoUrl = repoData.html_url as string;

    // 2. Add remote with PAT embedded (never logged)
    const remoteUrl = `https://${pat}@github.com/${username}/${repoName}.git`;
    const addRemote = await runCommand(
      `git -C ${dir} remote add origin ${shellEscape(remoteUrl)}`,
    );
    if (addRemote.exitCode !== 0) {
      // Remote might already exist — try set-url instead
      await runCommand(
        `git -C ${dir} remote set-url origin ${shellEscape(remoteUrl)}`,
      );
    }

    // 3. Ensure main branch
    await runCommand(`git -C ${dir} branch -M main`);

    // 4. Push
    const push = await runCommand(`git -C ${dir} push -u origin main`);
    if (push.exitCode !== 0) {
      return { success: false, error: 'Push failed. Check your network connection.' };
    }

    return { success: true, url: repoUrl };
  } catch (e: any) {
    return { success: false, error: e?.message || 'Network error' };
  }
}

/**
 * Push to an existing remote origin.
 */
export async function pushToExisting(params: {
  projectDir: string;
  pat: string;
  runCommand: RunCommandFn;
}): Promise<{ success: boolean; error?: string }> {
  const { projectDir, pat, runCommand } = params;
  const dir = shellEscape(projectDir);

  try {
    // Update remote URL with PAT for authentication
    const { stdout: currentUrl } = await runCommand(
      `git -C ${dir} remote get-url origin 2>/dev/null`,
    );
    const trimmedUrl = currentUrl.trim();

    if (trimmedUrl) {
      // Inject PAT into existing URL: https://github.com/... → https://<pat>@github.com/...
      const authedUrl = trimmedUrl.replace(
        /https:\/\/(.*@)?github\.com\//,
        `https://${pat}@github.com/`,
      );
      await runCommand(
        `git -C ${dir} remote set-url origin ${shellEscape(authedUrl)}`,
      );
    }

    const push = await runCommand(`git -C ${dir} push origin main`);
    if (push.exitCode !== 0) {
      return { success: false, error: 'Push failed. Check your network or permissions.' };
    }

    // Restore URL without PAT for safety
    if (trimmedUrl) {
      const cleanUrl = trimmedUrl.replace(
        /https:\/\/[^@]+@github\.com\//,
        'https://github.com/',
      );
      await runCommand(
        `git -C ${dir} remote set-url origin ${shellEscape(cleanUrl)}`,
      );
    }

    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message || 'Network error' };
  }
}

/**
 * Check if the project has a remote origin configured.
 */
export async function hasRemoteOrigin(
  projectDir: string,
  runCommand: RunCommandFn,
): Promise<boolean> {
  const dir = shellEscape(projectDir);
  const { exitCode } = await runCommand(
    `git -C ${dir} remote get-url origin 2>/dev/null`,
  );
  return exitCode === 0;
}

/**
 * Get the remote origin URL (without embedded credentials).
 */
export async function getRemoteUrl(
  projectDir: string,
  runCommand: RunCommandFn,
): Promise<string | null> {
  const dir = shellEscape(projectDir);
  const { stdout, exitCode } = await runCommand(
    `git -C ${dir} remote get-url origin 2>/dev/null`,
  );
  if (exitCode !== 0 || !stdout.trim()) return null;

  // Strip any embedded PAT from the URL before returning
  return stdout.trim().replace(/https:\/\/[^@]+@github\.com\//, 'https://github.com/');
}

/**
 * lib/cli-auth.ts — CLI Authentication Helper
 *
 * Manages authentication for CLI tools (Claude Code, Gemini CLI, Codex)
 * via the Termux bridge. Handles:
 * - API key storage in ~/.shellyrc (sourced by bridge)
 * - OAuth URL extraction from CLI login output
 * - Auth status verification
 *
 * All Termux interaction happens through the bridge — the user never
 * touches Termux directly.
 */

export type AuthToolId = 'claude-code' | 'gemini-cli' | 'codex';

export type AuthMethod = 'browser' | 'api-key';

export type AuthStatus = 'authenticated' | 'not-authenticated' | 'not-installed' | 'checking';

export interface AuthToolConfig {
  id: AuthToolId;
  name: string;
  /** Environment variable name for API key */
  envVar: string;
  /** URL to get an API key */
  apiKeyUrl: string;
  /** Command to check if installed */
  checkInstalled: string;
  /** Command to check if authenticated */
  checkAuth: string;
  /** Command to start OAuth login (if supported) */
  loginCommand?: string;
  /** Color for UI */
  color: string;
  /** Icon name (MaterialIcons) */
  icon: string;
}

export const AUTH_TOOL_CONFIGS: AuthToolConfig[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    envVar: 'ANTHROPIC_API_KEY',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    checkInstalled: 'which claude',
    checkAuth: 'test -n "$ANTHROPIC_API_KEY" && echo "authenticated" || (claude auth status 2>/dev/null | grep -qi "logged in" && echo "authenticated" || echo "not-authenticated")',
    loginCommand: 'claude auth login 2>&1',
    color: '#F59E0B',
    icon: 'code',
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    envVar: 'GEMINI_API_KEY',
    apiKeyUrl: 'https://aistudio.google.com/app/apikey',
    checkInstalled: 'which gemini',
    checkAuth: 'test -n "$GEMINI_API_KEY" -o -n "$GOOGLE_API_KEY" && echo "authenticated" || (gemini auth status 2>/dev/null | grep -qi "logged\\|cached\\|credential" && echo "authenticated" || echo "not-authenticated")',
    loginCommand: 'gemini auth login 2>&1',
    color: '#3B82F6',
    icon: 'auto-awesome',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    envVar: 'OPENAI_API_KEY',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    checkInstalled: 'which codex',
    checkAuth: 'test -n "$OPENAI_API_KEY" && echo "authenticated" || (codex login status 2>/dev/null | grep -qi "logged\\|authenticated" && echo "authenticated" || echo "not-authenticated")',
    loginCommand: 'codex login 2>&1',
    color: '#10B981',
    icon: 'terminal',
  },
];

/** Type for the bridge command runner */
export type AuthCommandRunner = (
  cmd: string,
  opts?: { timeoutMs?: number; onStream?: (type: 'stdout' | 'stderr', data: string) => void },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * Check authentication status of a tool.
 */
export async function checkAuthStatus(
  toolId: AuthToolId,
  runCommand: AuthCommandRunner,
): Promise<AuthStatus> {
  const config = AUTH_TOOL_CONFIGS.find((c) => c.id === toolId);
  if (!config) return 'not-installed';

  try {
    // First check if installed
    const installCheck = await runCommand(config.checkInstalled, { timeoutMs: 5000 });
    if (installCheck.exitCode !== 0) return 'not-installed';

    // Then check auth - source ~/.shellyrc first to get env vars
    const authCheck = await runCommand(
      `source ~/.shellyrc 2>/dev/null; ${config.checkAuth}`,
      { timeoutMs: 10000 },
    );
    const output = (authCheck.stdout || '').trim();
    return output.includes('authenticated') ? 'authenticated' : 'not-authenticated';
  } catch {
    return 'not-installed';
  }
}

/**
 * Check auth status for all tools at once.
 */
export async function checkAllAuthStatus(
  runCommand: AuthCommandRunner,
): Promise<Record<AuthToolId, AuthStatus>> {
  const results: Record<string, AuthStatus> = {};
  for (const config of AUTH_TOOL_CONFIGS) {
    results[config.id] = await checkAuthStatus(config.id, runCommand);
  }
  return results as Record<AuthToolId, AuthStatus>;
}

/**
 * Store an API key in ~/.shellyrc via bridge.
 * The bridge server should source this file on startup.
 */
export async function storeApiKey(
  toolId: AuthToolId,
  apiKey: string,
  runCommand: AuthCommandRunner,
): Promise<{ success: boolean; error?: string }> {
  const config = AUTH_TOOL_CONFIGS.find((c) => c.id === toolId);
  if (!config) return { success: false, error: 'Unknown tool' };

  const envVar = config.envVar;
  const escapedKey = apiKey.replace(/'/g, "'\\''");

  try {
    // Create ~/.shellyrc if not exists, remove old entry for this var, then append
    const cmd = [
      'touch ~/.shellyrc',
      `sed -i '/^export ${envVar}=/d' ~/.shellyrc`,
      `echo 'export ${envVar}='"'"'${escapedKey}'"'"'' >> ~/.shellyrc`,
      // Also export immediately so subsequent checks work
      `export ${envVar}='${escapedKey}'`,
      'echo "stored"',
    ].join(' && ');

    const result = await runCommand(cmd, { timeoutMs: 10000 });
    if (result.stdout?.includes('stored')) {
      return { success: true };
    }
    return { success: false, error: result.stderr || 'Failed to store key' };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/**
 * Remove an API key from ~/.shellyrc.
 */
export async function removeApiKey(
  toolId: AuthToolId,
  runCommand: AuthCommandRunner,
): Promise<{ success: boolean }> {
  const config = AUTH_TOOL_CONFIGS.find((c) => c.id === toolId);
  if (!config) return { success: false };

  try {
    await runCommand(
      `sed -i '/^export ${config.envVar}=/d' ~/.shellyrc 2>/dev/null; echo "done"`,
      { timeoutMs: 5000 },
    );
    return { success: true };
  } catch {
    return { success: false };
  }
}

/**
 * Verify that a stored API key actually works by running the tool's check.
 */
export async function verifyAuth(
  toolId: AuthToolId,
  runCommand: AuthCommandRunner,
): Promise<boolean> {
  const status = await checkAuthStatus(toolId, runCommand);
  return status === 'authenticated';
}

/**
 * Extract an OAuth URL from CLI login command output.
 * Claude Code outputs a URL during `claude auth login`.
 */
export function extractOAuthUrl(output: string): string | null {
  // Match common URL patterns from CLI output
  const urlMatch = output.match(/https?:\/\/[^\s"'<>]+/);
  return urlMatch ? urlMatch[0] : null;
}

/**
 * Get the config for a tool.
 */
export function getAuthToolConfig(toolId: AuthToolId): AuthToolConfig | undefined {
  return AUTH_TOOL_CONFIGS.find((c) => c.id === toolId);
}

/**
 * Ensure ~/.shellyrc is sourced by .bashrc
 */
export async function ensureShellyrcSourced(
  runCommand: AuthCommandRunner,
): Promise<void> {
  try {
    await runCommand(
      `grep -q 'source ~/.shellyrc' ~/.bashrc 2>/dev/null || echo '\\n# Shelly environment\\n[ -f ~/.shellyrc ] && source ~/.shellyrc' >> ~/.bashrc; echo "done"`,
      { timeoutMs: 5000 },
    );
  } catch {
    // Best-effort
  }
}

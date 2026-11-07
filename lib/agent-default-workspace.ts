/**
 * lib/agent-default-workspace.ts — where a CLI worker runs when its agent has
 * no `workspaceRoot`.
 *
 * This is a security boundary: the driver sets `policy.workspaceRoot` to its
 * cwd, and writes inside that root do not ask. The executor falls back to the
 * whole home when `cliWorker.cwd` is empty or missing, so a plan must always
 * name a real, narrow folder.
 *
 * The answer matches the generated script's PROJECT_DIR: the content project
 * where one exists (`SHELLY_CONTENT_PROJECT`, or the older default folder), so
 * those devices keep working where they did, and `~/agent-output` otherwise
 * (HomeInitializer creates it). An unknown or unsafe answer falls to
 * `~/agent-output`.
 *
 * buildAgentPlanSpec is synchronous, so the probe runs at startup
 * (loadAgentsFromDisk) and the result is cached here. Nothing in Shelly creates
 * the project any more, so the answer only changes between launches. A plan
 * built before the probe gets `~/agent-output`, the narrow side.
 */
import { validateWorkspaceRoot } from './agent-boundary-policy';

const PROBE_PREFIX = 'SHELLY_PROJECT_DIR=';

export const DEFAULT_WORKSPACE_PROBE =
  `p=$(sed -n "s/^SHELLY_CONTENT_PROJECT=//p" "$HOME/.shelly/agents/.env" 2>/dev/null | tail -n 1 | tr -d "'\\""); ` +
  `[ -n "$p" ] || p="$HOME/projects/shelly-content-studio"; ` +
  `[ -d "$p" ] && printf '${PROBE_PREFIX}%s\\n' "$p"; true`;

let existingProject: string | null = null;

/** Parse the probe's output: an absolute path after the marker, or null. Pure. */
export function parseDefaultWorkspaceProbe(output: string): string | null {
  const m = new RegExp(`^${PROBE_PREFIX}(/[^\\r\\n]+)$`, 'm').exec(String(output ?? ''));
  return m ? m[1] : null;
}

/** Re-read the device. A failed probe keeps the last answer. */
export async function refreshDefaultAgentWorkspace(run: (cmd: string) => Promise<string>): Promise<void> {
  try {
    existingProject = parseDefaultWorkspaceProbe(await run(DEFAULT_WORKSPACE_PROBE));
  } catch {
    // keep the last answer
  }
}

/** The folder a CLI worker with no `workspaceRoot` runs in. Never the home. */
export function defaultAgentWorkspace(home: string): string {
  const fallback = `${home}/agent-output`;
  if (!existingProject) return fallback;
  const safe = validateWorkspaceRoot(existingProject, [
    home,
    '/data/user/0/dev.shelly.terminal/files/home',
    '/data/data/dev.shelly.terminal/files/home',
  ]).ok;
  return safe ? existingProject : fallback;
}

export function __resetDefaultAgentWorkspaceForTests(): void {
  existingProject = null;
}

import { execCommand } from '@/hooks/use-native-exec';
import { getHomePath } from '@/lib/home-path';

export type Workflow = {
  name: string;
  commands: string[];
  description?: string;
  createdAt: number;
};

function getWorkflowsDir(): string {
  return `${getHomePath()}/.shelly/workflows`;
}

export async function ensureWorkflowsDir() {
  await execCommand(`mkdir -p "${getWorkflowsDir()}"`);
}

/** Strict-mode prologue added to `shelly teach` workflows. Excluded from
 *  the command list on load (and by the native shim's list/show parser). */
export const WORKFLOW_STRICT_LINE = 'set -euo pipefail';

export async function saveWorkflow(
  name: string,
  commands: string[],
  description?: string,
  options: { strict?: boolean } = {},
): Promise<void> {
  await ensureWorkflowsDir();
  const content = [
    '#!/bin/bash',
    `# Shelly Workflow: ${name}`,
    description ? `# ${description}` : '',
    `# Created: ${new Date().toISOString()}`,
    options.strict ? WORKFLOW_STRICT_LINE : '',
    '',
    ...commands,
  ].filter(Boolean).join('\n');
  // Write using base64 to avoid shell escaping
  const b64 = btoa(unescape(encodeURIComponent(content)));
  await execCommand(`echo '${b64}' | base64 -d > "${getWorkflowsDir()}/${name}.sh" && chmod +x "${getWorkflowsDir()}/${name}.sh"`);
}

export async function loadWorkflow(name: string): Promise<Workflow | null> {
  const result = await execCommand(`cat "${getWorkflowsDir()}/${name}.sh" 2>/dev/null`);
  if (result.exitCode !== 0) return null;
  const lines = result.stdout.split('\n');
  const commands = lines.filter(l => !l.startsWith('#') && !l.startsWith('!') && l.trim() && l.trim() !== WORKFLOW_STRICT_LINE);
  const descLine = lines.find(l => l.startsWith('# ') && !l.includes('Shelly Workflow') && !l.includes('Created'));
  return { name, commands, description: descLine?.replace(/^#\s*/, ''), createdAt: Date.now() };
}

export async function listWorkflows(): Promise<Workflow[]> {
  await ensureWorkflowsDir();
  const result = await execCommand(`ls -1 "${getWorkflowsDir()}"/*.sh 2>/dev/null`);
  if (result.exitCode !== 0) return [];
  const files = result.stdout.trim().split('\n').filter(Boolean);
  const workflows: Workflow[] = [];
  for (const f of files) {
    const name = f.split('/').pop()?.replace('.sh', '') ?? '';
    const wf = await loadWorkflow(name);
    if (wf) workflows.push(wf);
  }
  return workflows;
}

export async function deleteWorkflow(name: string): Promise<boolean> {
  const result = await execCommand(`rm -f "${getWorkflowsDir()}/${name}.sh"`);
  return result.exitCode === 0;
}

export function substituteParams(commands: string[], args: string[]): string[] {
  return commands.map(cmd => {
    let result = cmd;
    args.forEach((arg, i) => { result = result.replace(new RegExp(`\\$${i + 1}`, 'g'), arg); });
    return result;
  });
}

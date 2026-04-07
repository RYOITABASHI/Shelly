import { execCommand } from '@/hooks/use-native-exec';

export type Workflow = {
  name: string;
  commands: string[];
  description?: string;
  createdAt: number;
};

const WORKFLOWS_DIR = '/data/data/com.termux/files/home/.shelly/workflows';

export async function ensureWorkflowsDir() {
  await execCommand(`mkdir -p "${WORKFLOWS_DIR}"`);
}

export async function saveWorkflow(name: string, commands: string[], description?: string): Promise<void> {
  await ensureWorkflowsDir();
  const content = [
    '#!/bin/bash',
    `# Shelly Workflow: ${name}`,
    description ? `# ${description}` : '',
    `# Created: ${new Date().toISOString()}`,
    '',
    ...commands,
  ].filter(Boolean).join('\n');
  // Write using base64 to avoid shell escaping
  const b64 = btoa(unescape(encodeURIComponent(content)));
  await execCommand(`echo '${b64}' | base64 -d > "${WORKFLOWS_DIR}/${name}.sh" && chmod +x "${WORKFLOWS_DIR}/${name}.sh"`);
}

export async function loadWorkflow(name: string): Promise<Workflow | null> {
  const result = await execCommand(`cat "${WORKFLOWS_DIR}/${name}.sh" 2>/dev/null`);
  if (result.exitCode !== 0) return null;
  const lines = result.stdout.split('\n');
  const commands = lines.filter(l => !l.startsWith('#') && !l.startsWith('!') && l.trim());
  const descLine = lines.find(l => l.startsWith('# ') && !l.includes('Shelly Workflow') && !l.includes('Created'));
  return { name, commands, description: descLine?.replace(/^#\s*/, ''), createdAt: Date.now() };
}

export async function listWorkflows(): Promise<Workflow[]> {
  await ensureWorkflowsDir();
  const result = await execCommand(`ls -1 "${WORKFLOWS_DIR}"/*.sh 2>/dev/null`);
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
  const result = await execCommand(`rm -f "${WORKFLOWS_DIR}/${name}.sh"`);
  return result.exitCode === 0;
}

export function substituteParams(commands: string[], args: string[]): string[] {
  return commands.map(cmd => {
    let result = cmd;
    args.forEach((arg, i) => { result = result.replace(new RegExp(`\\$${i + 1}`, 'g'), arg); });
    return result;
  });
}

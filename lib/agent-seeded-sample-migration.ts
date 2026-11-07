/**
 * lib/agent-seeded-sample-migration.ts — one-time switch-off of the sample
 * agents older builds wrote into ~/.shelly/agents.
 *
 * Those builds could add seven sample agents, enabled and partly on a cron, to
 * any device that had a certain project folder, and ordinary agents created
 * that folder. The seed is gone; this turns off what it left behind so it stops
 * using the user's API quota. Nothing is deleted.
 *
 * Identification: an agent counts as the sample only if the hash of its id is
 * in the table AND a fingerprint of its whole definition equals one the seed
 * really wrote (every variant in git history, so a device that skipped builds
 * is covered). The `version` / `createdAt` values the seed stored are NOT used:
 * no edit path changes them, so an edited sample still carries them. The table
 * holds only hashes, of the ids too: neither the seed text nor its ids are
 * meant to ship again.
 *
 * Anything else with a seed id is treated as the user's: left enabled, left
 * byte-identical, and logged by id. Agents created by Shelly have `agent-<ts>`
 * ids and are never looked at, whatever their name.
 *
 * Once-only: the marker is `seedMigration` in the agent's own JSON, written in
 * the same atomic rename as `enabled:false`, so the two cannot disagree after a
 * crash and there is no hydration race with AsyncStorage. No new file or
 * directory. A sample that was already off gets the marker too, or turning it
 * on later would look like a first run. Every writer spreads the agent, so the
 * marker survives a later toggle or edit.
 */
import { stableStringify } from '@/lib/agent-add-approval';
import { logInfo, logWarn } from '@/lib/debug-logger';
import { sha256Hex } from '@/lib/sha256';
import type { Agent } from '@/store/types';

const LOG_MODULE = 'AgentSeedMigration';
const SEED_PROJECT_SEGMENT = '/projects/shelly-content-studio/';

/** Generated from the seed's git history: seededAgentIdHash(id) to the
 *  fingerprints of that id's variants, 22 across the seven ids. */
export const SEEDED_SAMPLE_FINGERPRINTS: Readonly<Record<string, readonly string[]>> = {
  'ec1ccd8ca66b5b5dc1e365296e6790329b559506a0facb1fdfde265822c555a4': [
    'd5ab1fbb879dcb8a540ae13b98f7693afda0efc07e0ec18a924e3dc1e5d53cfd',
    '1cadc0f1219cceab646d71f0aedca65eade6f82dce85fb7b594cc6210c3266d2',
  ],
  'ed17a9985a7effc9aba125d9acaa4ba7fa0cb13b5667fc3dcb5af5ed2aa99e0d': [
    'd35633debba52d02aa2bc6175a787cedf1ee59ada165973e529475e91e81a86c',
    'f8e6c8e172b64103aee9252c1ecc7309ff6bb46b7ecbfefd636826304ddd6148',
    'cec2c75f113e0505ee5928fa9059aa0db215fcbf2f8e75654df638c9511f9525',
    '6eaffc6b2652a4c959bf1319e12592cc1e500334e19c82f55f47e1e4ce4db7b5',
  ],
  '330efd260dcda5909a9753beb4c9b7a256a08cf3c4fe7311e91b2d6ace781db6': [
    '9217473de40667ff9f7c92bd5f9a56391260c65eb953c34b2871db04315ec6f5',
    '2650719db82ca71bf6662ba265adcb6efa2bd3f13cd92266503f9d2214ad1f48',
  ],
  '4c2a430b443fa53d698b71c3fd3d3cb4f6564a590f598b7de2302dd599903df1': [
    'f33365f71997e851f725030a1700c7350340601b9f7f5492bc128ab1b1fc3e94',
    '7bc0f55ac3598c4915774f81d254744f8466f33d3b2c49a32cb1f2de57297f3d',
    '0d1274a240c8df85427b4ce7b5cf9b8615abdef87ca656580685e9eacd1792ee',
    '363131b76836e0263a8078bf86f4dfebc445085f2b9647e2be5343d42ab693a0',
    '261387cd07dcce73c0356e4154769dfacdb7b5d9881fe4715e9897f8891cff22',
    '80eee8a3a0ddb08c3db518a1ceb7bfac3deee1e0b030de6f939729605bd19413',
  ],
  '89b28e789d708d80300d8f359fbd4268393d410109087edf185f51032256d1c8': [
    'ac59d8dd0fad2aa867c73aa3262a7620d3b4a8298234b60b7ff2a5ab21a1d043',
    '55cc448776b59113ba64c86e88f7f28f52d5cc45e7dc2c95a33d6588f9b92ad5',
  ],
  'f783806784da868903e6f870fb4f0763ededa3efbe2249d9d5a6ec25c23c3687': [
    '36308abb90bdb11ad3b7d9362e3591ae4cc955f4c4b3235c72dc42033de90579',
    '1a04f84ae953115982852044cca40108327aa41959be4fdfd5c5e8517c094fe0',
  ],
  'dbaee1d86c2f6c846aa5b4ab9516d141c3ef961ea54b673752bb5582287a0d44': [
    'ab2b8caba128acce58acad8333b2df7d79810a741373654bfce15e36e10aad4c',
    'fb89b8cf62d5afb7bb3b183256c56b8bd8c52ba7e4d8e4ba7727395479085162',
    'aaaf944cb9ba3f423d907ccdaf42e329d62a0212a982a5f21d37efd500a7bcfb',
    '0e6e02ec529c94060ce6ab8c58b727f413865d66fb8c6a3380551082d35c8d0d',
  ],
};

/** Fields the seed never set. A value in any of them means someone configured
 *  the agent after it was seeded (`orchestration` covers longform plans). */
const FIELDS_THE_SEED_NEVER_SET: readonly (keyof Agent)[] = [
  'action',
  'actions',
  'autonomous',
  'autonomyLevel',
  'continuous',
  'memory',
  'notificationTrigger',
  'orchestration',
  'outputTemplate',
  'requireActionApproval',
  'roleRef',
  'runOn',
  'skillId',
  'startNotBefore',
  'workspaceRoot',
];

function isUnset(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === '') return true;
  return Array.isArray(value) && value.length === 0;
}

export function seededAgentIdHash(agentId: string): string {
  return sha256Hex(`shelly-seeded-agent-id-v1\n${agentId}`);
}

/** Fingerprint of what the seed wrote. `outputPath` is compared from the seed
 *  folder down, because its home prefix differs between path aliases. */
export function seededSampleFingerprint(agent: Agent): string | null {
  const outputPath = typeof agent.outputPath === 'string' ? agent.outputPath : '';
  const at = outputPath.indexOf(SEED_PROJECT_SEGMENT);
  if (at < 0) return null;
  const definition = {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    prompt: agent.prompt,
    schedule: agent.schedule ?? null,
    tool: agent.tool,
    output: outputPath.slice(at + SEED_PROJECT_SEGMENT.length),
  };
  return sha256Hex(`shelly-seeded-agent-v1\n${stableStringify(definition)}`);
}

export type SeededSampleClass =
  | 'other' // not a seed id: never touched
  | 'handled' // the migration already ran for this agent
  | 'sample' // unchanged sample
  | 'unsure'; // a seed id whose definition differs: the user's, or unknown

export function classifySeededSample(
  agent: Agent,
  table: Readonly<Record<string, readonly string[]>> = SEEDED_SAMPLE_FINGERPRINTS,
): SeededSampleClass {
  const fingerprints = table[seededAgentIdHash(agent.id)];
  if (!fingerprints) return 'other';
  if (agent.seedMigration) return 'handled';
  if (FIELDS_THE_SEED_NEVER_SET.some((field) => !isUnset(agent[field]))) return 'unsure';
  const fingerprint = seededSampleFingerprint(agent);
  return fingerprint !== null && fingerprints.includes(fingerprint) ? 'sample' : 'unsure';
}

export interface SeededSampleMigrationDeps {
  /** Current JSON of the agent; null when missing or unreadable. */
  readAgent: (agentId: string) => Promise<Agent | null>;
  /** Atomic write of the whole agent JSON. Throws on failure. */
  writeAgent: (agent: Agent) => Promise<void>;
  /** The normal alarm cancel. */
  cancelAlarm: (agentId: string) => Promise<void>;
  /** Tests only. */
  table?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Returns the list with the changed agents replaced. Runs before the store is
 * filled and before startup repair takes its snapshot, so an agent turned off
 * here is not re-armed. Never throws: a failure leaves that agent as it was and
 * the next launch tries again.
 *
 * Order: the file first, the alarm second. A failed cancel loses nothing, since
 * native refuses an unattended run unless the JSON says enabled
 * (AgentRuntime.isAgentEnabled), and re-arming drops the alarm of a disabled
 * agent (AgentAlarmScheduler.scheduleNextIfAgentEnabled). A run already going is
 * left to finish.
 */
export async function migrateSeededSampleAgents(
  agents: Agent[],
  deps: SeededSampleMigrationDeps,
): Promise<Agent[]> {
  const table = deps.table ?? SEEDED_SAMPLE_FINGERPRINTS;
  const result = [...agents];
  for (let i = 0; i < result.length; i += 1) {
    const listed = result[i];
    let listedClass: ReturnType<typeof classifySeededSample>;
    try {
      listedClass = classifySeededSample(listed, table);
    } catch (error) {
      logWarn(LOG_MODULE, `left as it is, could not read: ${listed.id}`, error);
      continue;
    }
    if (listedClass === 'other' || listedClass === 'handled') continue;
    if (listedClass === 'unsure') {
      logInfo(LOG_MODULE, `left as it is, cannot tell it is the sample: ${listed.id}`);
      continue;
    }
    let turnedOff = false;
    try {
      // The list may be a moment old: native writes run state to this file.
      const current = await deps.readAgent(listed.id);
      if (!current || classifySeededSample(current, table) !== 'sample') {
        logInfo(LOG_MODULE, `skipped, changed since it was listed: ${listed.id}`);
        continue;
      }
      turnedOff = current.enabled !== false;
      const next: Agent = {
        ...current,
        enabled: false,
        seedMigration: turnedOff ? 'turned-off' : 'left-off',
      };
      await deps.writeAgent(next);
      result[i] = next;
      logInfo(LOG_MODULE, `${next.seedMigration}: ${next.id}`);
    } catch (error) {
      logWarn(LOG_MODULE, `not applied, will retry next launch: ${listed.id}`, error);
      continue;
    }
    if (!turnedOff) continue;
    try {
      await deps.cancelAlarm(listed.id);
    } catch (error) {
      logWarn(LOG_MODULE, `alarm cancel failed, the agent stays disabled: ${listed.id}`, error);
    }
  }
  return result;
}

/** True when the one-time notice has something to say. An agent that was
 *  already off does not count: nothing changed for the user. */
export function hasTurnedOffSeededSample(agents: readonly Agent[]): boolean {
  return agents.some((agent) => agent.seedMigration === 'turned-off');
}

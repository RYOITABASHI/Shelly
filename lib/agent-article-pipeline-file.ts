/**
 * lib/agent-article-pipeline-file.ts — the user's article pipeline config.
 *
 * Shelly ships no article agent. A user who wants one writes
 * ~/.shelly/agents/article-pipelines.json (see ArticlePipelineFile in
 * lib/agent-pipeline-presets.ts) and asks for it by id in chat:
 * `@agent 記事パイプライン <id>` / `@agent article pipeline <id>`.
 *
 * The gate hard-denies agent CLI writes to it, by full path and by basename
 * after a `cd` ('policy-write', touchesProtectedPolicyFiles in
 * lib/agent-boundary-policy.ts). The file has no top-level `id`, so the
 * agents-dir scanners skip it. It is read only at creation: the agent gets a
 * snapshot, and the usual typed OK is still required.
 */
import {
  buildArticleDigestPipeline,
  buildArticlePipeline,
  articleOutputFolderError,
  parseArticlePipelineFile,
  type ArticleOutputRoots,
  type PipelinePreset,
} from './agent-pipeline-presets';

export const ARTICLE_PIPELINE_FILE_PATH = '~/.shelly/agents/article-pipelines.json';
const ARTICLE_PIPELINE_FILE_MAX_BYTES = 256 * 1024;
const FILE_MISSING_EXIT = 44;
const DEFAULT_VAULT_PATH = '/sdcard/Documents/ObsidianVault';

/** The roots a pipeline may save under, as the agent env resolves them. */
export function articleOutputRoots(settings: { agentVaultPath?: string; agentCustomPath?: string }, home: string): ArticleOutputRoots {
  const expand = (p: string) => (p === '~' || p.startsWith('~/') ? `${home}${p.slice(1)}` : p);
  return {
    vault: expand((settings.agentVaultPath ?? '').trim() || DEFAULT_VAULT_PATH),
    custom: expand((settings.agentCustomPath ?? '').trim() || `${home}/agent-output`),
  };
}

export type ArticlePipelineLookup =
  | { preset: PipelinePreset }
  | { refusal: 'missing' }
  | { refusal: 'invalid'; detail: string }
  | { refusal: 'pick'; ids: string[] };

export type ArticlePipelineFileRunner = (cmd: string) => Promise<{ stdout: string; exitCode: number | null }>;

/** The named pipeline in `utterance`, or the only one when no name is given. Pure. */
export function selectArticlePipeline(fileText: string, utterance: string, roots: ArticleOutputRoots): ArticlePipelineLookup {
  const parsed = parseArticlePipelineFile(fileText);
  if ('error' in parsed) return { refusal: 'invalid', detail: parsed.error };
  const { pipelines, digest } = parsed.file;
  const ids = [...pipelines.map((p) => p.id), ...(digest ? ['digest'] : [])];
  const words = utterance.toLowerCase().split(/[^a-z0-9-]+/);
  const named = ids.filter((id) => words.includes(id));
  const id = named.length === 1 ? named[0] : named.length === 0 && ids.length === 1 ? ids[0] : null;
  if (id === null) return { refusal: 'pick', ids };
  const config = pipelines.find((p) => p.id === id);
  const folder = config ? config.outputFolder : digest!.outputFolder;
  const folderError = articleOutputFolderError(folder, roots, config ? config.queue === true : true);
  if (folderError) return { refusal: 'invalid', detail: folderError };
  return { preset: config ? buildArticlePipeline(config) : buildArticleDigestPipeline(digest!) };
}

/** Read the file and pick from it. Never throws. A symlink counts as missing. */
export async function loadArticlePipeline(utterance: string, run: ArticlePipelineFileRunner, roots: ArticleOutputRoots): Promise<ArticlePipelineLookup> {
  try {
    const result = await run(
      `f="$HOME/.shelly/agents/article-pipelines.json"; if [ ! -f "$f" ] || [ -L "$f" ]; then exit ${FILE_MISSING_EXIT}; fi; head -c ${ARTICLE_PIPELINE_FILE_MAX_BYTES + 1} "$f"`,
    );
    if (result.exitCode === FILE_MISSING_EXIT) return { refusal: 'missing' };
    if (result.exitCode !== 0) return { refusal: 'invalid', detail: 'could not read the file' };
    if (result.stdout.length > ARTICLE_PIPELINE_FILE_MAX_BYTES) return { refusal: 'invalid', detail: 'file is too large' };
    return selectArticlePipeline(result.stdout, utterance, roots);
  } catch {
    return { refusal: 'invalid', detail: 'could not read the file' };
  }
}

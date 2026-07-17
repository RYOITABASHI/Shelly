/**
 * lib/skill-catalog.ts — first-party, curated skill catalog (follow-up to
 * SKILL-001's local-drop-only import, see docs/superpowers/DEFERRED.md's
 * 2026-07-08 SKILL-001 entry for why a *live* agentskills.io registry search
 * isn't buildable: the open standard has no searchable registry API).
 *
 * Instead of a search engine, this is a small hand-curated catalog published
 * the SAME way Shelly already publishes its own app + Codex runtime updates —
 * a versioned GitHub Release (`skills-catalog-latest`) carrying a JSON
 * manifest asset (`skills-catalog.json`), fetched and sha256-verified with the
 * exact trust model components/layout/BuildsModal.tsx already uses for
 * `latest.json` / `codex-runtime.json`: never trust a downloaded asset whose
 * hash doesn't match what the manifest itself declared.
 *
 * This module ONLY fetches, verifies, and hands off SKILL.md content — it
 * NEVER writes it into the imported/trusted pool directly. A catalog entry
 * goes through lib/skill-import.ts's `importSkillContentToQuarantine`, the
 * exact same human quarantine → approve/reject review a manually-dropped
 * SKILL.md gets. A compromised or buggy manifest entry gets no free pass.
 *
 * Deliberately framework-free (no React Native imports beyond global fetch)
 * so it's fully unit-testable from the plain ts-jest "unit" project — see
 * __tests__/skill-catalog.test.ts.
 */
import { SKILL_NAME_RE, MAX_DESCRIPTION_CHARS } from '@/lib/skill-import';

/** Parity with BuildsModal.tsx's REPO const. Duplicated rather than imported
 *  from a .tsx component file to keep this module component-import-free. */
const REPO = 'RYOITABASHI/Shelly';

/** Same naming convention as BuildsModal's STABLE_UPDATE_TAG/UPDATE_MANIFEST_ASSET
 *  and CODEX_RUNTIME_TAG/CODEX_RUNTIME_MANIFEST_ASSET — a third sibling channel. */
export const SKILLS_CATALOG_TAG = 'skills-catalog-latest';
export const SKILLS_CATALOG_MANIFEST_ASSET = 'skills-catalog.json';

const CATALOG_NETWORK_TIMEOUT_MS = 15_000;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;
/** Asset-name shape for the per-skill raw SKILL.md content, e.g.
 *  "git-commit-craft.SKILL.md" — parity with BuildsModal's APK_NAME_RE /
 *  TARBALL_NAME_RE conventions. */
const CONTENT_ASSET_NAME_RE = /^[A-Za-z0-9._-]+\.SKILL\.md$/;

export interface SkillCatalogEntry {
  /** Must match SKILL_NAME_RE — same shape lib/skill-import.ts requires for a
   *  locally-imported skill's frontmatter `name`, and becomes the quarantine
   *  directory name after import. */
  name: string;
  description: string;
  version?: string;
  tags?: string[];
  /** Asset filename, e.g. "git-commit-craft.SKILL.md" — display/debug only. */
  contentAssetName: string;
  /** https:// URL to fetch the raw SKILL.md text from (a GitHub release asset
   *  download URL once CI publishes this channel). */
  contentUrl: string;
  /** Lowercase hex sha256 of the exact bytes served at contentUrl. The single
   *  source of trust: fetchCatalogSkillContent refuses to hand back content
   *  whose digest doesn't match this. */
  sha256: string;
}

export interface SkillCatalogManifest {
  schemaVersion: number;
  channel?: string;
  generatedAt?: string;
  gitSha?: string;
  runId?: number;
  runNumber?: number;
  skills: SkillCatalogEntry[];
}

export interface SkillCatalogParseResult {
  /** True when the manifest's own shape (object, schemaVersion, `skills`
   *  array) is usable — independent of whether individual entries were
   *  dropped. A manifest with zero valid entries but a sound top-level shape
   *  is still `valid: true` with an empty `skills` list; check `errors` to
   *  see what was dropped and why. */
  valid: boolean;
  errors: string[];
  manifest?: SkillCatalogManifest;
}

function validateCatalogEntry(rawEntry: unknown, index: number): { entry?: SkillCatalogEntry; errors: string[] } {
  if (typeof rawEntry !== 'object' || rawEntry === null) {
    return { errors: [`skills[${index}] is not an object`] };
  }
  const e = rawEntry as Record<string, unknown>;
  const errors: string[] = [];
  const label = typeof e.name === 'string' && e.name ? e.name : `skills[${index}]`;

  const name = typeof e.name === 'string' ? e.name : '';
  if (!name || !SKILL_NAME_RE.test(name)) {
    errors.push(`${label}.name is missing or invalid`);
  }

  const description = typeof e.description === 'string' ? e.description : '';
  if (!description) {
    errors.push(`${label}.description is required`);
  } else if (description.length > MAX_DESCRIPTION_CHARS) {
    errors.push(`${label}.description exceeds ${MAX_DESCRIPTION_CHARS} characters`);
  }

  const contentUrl = typeof e.contentUrl === 'string' ? e.contentUrl : '';
  if (!/^https:\/\//i.test(contentUrl)) {
    errors.push(`${label}.contentUrl must be an https:// URL`);
  }

  const contentAssetName = typeof e.contentAssetName === 'string' ? e.contentAssetName : '';
  if (!CONTENT_ASSET_NAME_RE.test(contentAssetName)) {
    errors.push(`${label}.contentAssetName is missing or invalid`);
  }

  const sha256Raw = typeof e.sha256 === 'string' ? e.sha256.toLowerCase() : '';
  if (!SHA256_HEX_RE.test(sha256Raw)) {
    errors.push(`${label}.sha256 is missing or invalid`);
  }

  if (errors.length > 0) return { errors };

  const version = typeof e.version === 'string' ? e.version : undefined;
  const tags = Array.isArray(e.tags) ? e.tags.filter((tag): tag is string => typeof tag === 'string') : undefined;

  return {
    errors: [],
    entry: {
      name,
      description,
      version,
      tags,
      contentAssetName,
      contentUrl,
      sha256: sha256Raw,
    },
  };
}

/**
 * Pure, IO-free manifest validation — unit-testable without a network call.
 * Malformed individual entries are dropped (with their reason recorded in
 * `errors`) rather than failing the whole catalog, so one bad curated entry
 * never hides every other valid skill.
 */
export function parseSkillCatalogManifest(raw: unknown): SkillCatalogParseResult {
  if (typeof raw !== 'object' || raw === null) {
    return { valid: false, errors: ['skills catalog manifest is not a JSON object'] };
  }
  const obj = raw as Record<string, unknown>;

  const schemaVersion = Number(obj.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    return { valid: false, errors: ['skills catalog manifest schemaVersion is missing or invalid'] };
  }

  if (!Array.isArray(obj.skills)) {
    return { valid: false, errors: ['skills catalog manifest "skills" field is missing or not an array'] };
  }

  const errors: string[] = [];
  const skills: SkillCatalogEntry[] = [];
  const seenNames = new Set<string>();
  obj.skills.forEach((rawEntry, index) => {
    const result = validateCatalogEntry(rawEntry, index);
    if (result.errors.length > 0) {
      errors.push(...result.errors);
      return;
    }
    const entry = result.entry!;
    if (seenNames.has(entry.name)) {
      errors.push(`skills[${index}] (${entry.name}) is a duplicate name — skipped`);
      return;
    }
    seenNames.add(entry.name);
    skills.push(entry);
  });

  return {
    valid: true,
    errors,
    manifest: {
      schemaVersion,
      channel: typeof obj.channel === 'string' ? obj.channel : undefined,
      generatedAt: typeof obj.generatedAt === 'string' ? obj.generatedAt : undefined,
      gitSha: typeof obj.gitSha === 'string' ? obj.gitSha : undefined,
      runId: Number.isInteger(Number(obj.runId)) ? Number(obj.runId) : undefined,
      runNumber: Number.isInteger(Number(obj.runNumber)) ? Number(obj.runNumber) : undefined,
      skills,
    },
  };
}

async function fetchWithCatalogTimeout(url: string, accept: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATALOG_NETWORK_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { Accept: accept, 'User-Agent': 'Shelly' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch + verify the catalog manifest, mirroring BuildsModal.tsx's
 * fetchLatestAndroidUpdate/fetchLatestCodexRuntime shape: resolve a GitHub
 * Releases tag, find the named JSON asset, fetch and validate it. Returns
 * null (not an error) when the release/tag doesn't exist yet — the CI
 * publish step for this channel is a follow-up, not yet wired, so a fresh
 * checkout of this feature should degrade to "catalog unavailable" rather
 * than throwing.
 */
export async function fetchSkillCatalogManifest(): Promise<SkillCatalogManifest | null> {
  const releaseUrl = `https://api.github.com/repos/${REPO}/releases/tags/${SKILLS_CATALOG_TAG}`;
  const releaseResponse = await fetchWithCatalogTimeout(releaseUrl, 'application/vnd.github+json');
  if (releaseResponse.status === 404) return null;
  if (!releaseResponse.ok) {
    const body = await releaseResponse.text().catch(() => '');
    throw new Error(body || `GitHub skills catalog release API HTTP ${releaseResponse.status}`);
  }

  const release = await releaseResponse.json();
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const manifestAsset = assets.find((asset: any) => asset?.name === SKILLS_CATALOG_MANIFEST_ASSET);
  if (!manifestAsset?.browser_download_url) {
    throw new Error(`Release ${SKILLS_CATALOG_TAG} has no ${SKILLS_CATALOG_MANIFEST_ASSET} asset.`);
  }

  const manifestResponse = await fetchWithCatalogTimeout(String(manifestAsset.browser_download_url), 'application/json');
  if (!manifestResponse.ok) {
    const body = await manifestResponse.text().catch(() => '');
    throw new Error(body || `GitHub skills catalog manifest HTTP ${manifestResponse.status}`);
  }

  const raw = await manifestResponse.json();
  const result = parseSkillCatalogManifest(raw);
  if (!result.valid || !result.manifest) {
    throw new Error(result.errors.join('\n') || 'skills catalog manifest is malformed');
  }
  return result.manifest;
}

/**
 * expo-crypto is a native-module-backed package. Importing it statically at
 * this module's top would make ANY test file that merely imports
 * skill-catalog.ts fail to parse under the plain ts-jest "unit" project
 * (same class of bug fixed for lib/memory/crypto-expo.ts in 303c36efe — see
 * that commit for the full story). Lazy require() keeps the dependency
 * confined to the one call path that actually needs it, and jest.mock still
 * intercepts require() calls exactly like static imports.
 */
async function sha256Hex(content: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Crypto = require('expo-crypto') as typeof import('expo-crypto');
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, content, {
    encoding: Crypto.CryptoEncoding.HEX,
  });
  return String(digest).toLowerCase();
}

/**
 * Flat `{ ok, ...optional }` shape (not a discriminated union) — same
 * convention lib/skill-import.ts's importSkillToQuarantine and
 * modules/terminal-emulator's verifyApkFile already use for result types in
 * this codebase. `content` is set iff `ok`; `error` is set iff `!ok`.
 */
export interface FetchCatalogSkillContentResult {
  ok: boolean;
  content?: string;
  error?: string;
}

/**
 * Download a catalog entry's SKILL.md content and verify it against the
 * manifest-declared sha256 — the same never-trust-an-unverified-download
 * discipline BuildsModal.tsx's downloadReleaseApk/installCodexRuntime apply
 * before ever handing bytes to an install/import step. On mismatch this
 * returns a failure result (never throws), so callers can surface it in a
 * plain-text UI error the same way skill-import.ts's validation errors are
 * shown today.
 */
export async function fetchCatalogSkillContent(entry: SkillCatalogEntry): Promise<FetchCatalogSkillContentResult> {
  let response: Response;
  try {
    response = await fetchWithCatalogTimeout(entry.contentUrl, 'text/plain, text/markdown, */*');
  } catch (e: any) {
    return { ok: false, error: `download failed: ${String(e?.message || e)}` };
  }
  if (!response.ok) {
    return { ok: false, error: `download failed: HTTP ${response.status}` };
  }
  let content: string;
  try {
    content = await response.text();
  } catch (e: any) {
    return { ok: false, error: `download failed: ${String(e?.message || e)}` };
  }

  const expected = entry.sha256.toLowerCase();
  let actual: string;
  try {
    actual = await sha256Hex(content);
  } catch (e: any) {
    return { ok: false, error: `sha256 verification failed: ${String(e?.message || e)}` };
  }
  if (actual !== expected) {
    return { ok: false, error: `sha256 mismatch: expected ${expected}, got ${actual}` };
  }
  return { ok: true, content };
}

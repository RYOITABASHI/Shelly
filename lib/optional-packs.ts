/**
 * lib/optional-packs.ts — on-demand "optional tool pack" manifest.
 *
 * Fable5 product-review roadmap item #6: the ~800MB sideloaded APK is the
 * single biggest barrier to anyone trying Shelly cold (no Play Store
 * listing). The eventual fix is to ship a smaller "core" bundle (bash,
 * Node.js, git, coreutils) and move a larger "optional" tool set out of the
 * always-bundled jniLibs into packs fetched on demand via `shelly install
 * <pack-id>`.
 *
 * This module is ONLY the data description of what would live in an
 * optional pack. It intentionally changes nothing about what LibExtractor.kt
 * extracts unconditionally on first launch and nothing about what CI packages
 * into jniLibs — see CLAUDE.md item #6 for why that step is explicitly
 * deferred to a dedicated on-device QA pass. `published` is false for every
 * pack below because no pack archive has actually been built or uploaded to
 * a GitHub release yet; `downloadUrl` is a clearly-marked placeholder, not a
 * real asset.
 */

export interface OptionalPackManifest {
  /** Stable, lowercase-hyphen id used on the CLI: `shelly install <id>`. */
  id: string;
  /** Short human-readable label. */
  label: string;
  /** One-sentence description of what the pack is for. */
  description: string;
  /** Binary/tool names bundled in this pack, as they'd appear once wired onto PATH. */
  tools: string[];
  /** Expected archive file name (.tar.gz) once the pack is actually built. */
  archiveAssetName: string;
  /**
   * Placeholder GitHub Releases URL. Not a real, uploaded asset — see
   * `published` below. Wiring this to a real release asset is deferred
   * remainder work (CLAUDE.md item #6 / DEFERRED.md).
   */
  downloadUrl: string;
  /** Expected sha256 of the archive, unknown until the archive is actually built and published. */
  sha256: string | null;
  /** Best-effort expected download size in bytes, for CLI display; unknown until built. */
  approxSizeBytes: number | null;
  /**
   * Gate: true only once a real release asset backs `downloadUrl`. False for
   * every pack today — `shelly install <pack>` refuses to attempt a download
   * against a pack that isn't published yet, rather than hitting a dead URL.
   */
  published: boolean;
}

const REPO = 'RYOITABASHI/Shelly';
// Placeholder release tag — no such release exists yet. Marked clearly so a
// future implementer building the real pack-publishing CI step knows exactly
// what to replace, rather than silently trusting a URL that looks real.
const PLACEHOLDER_RELEASE_TAG = 'optional-packs-latest-TODO-NOT-YET-PUBLISHED';

function placeholderDownloadUrl(archiveAssetName: string): string {
  return `https://github.com/${REPO}/releases/download/${PLACEHOLDER_RELEASE_TAG}/${archiveAssetName}`;
}

// Two packs, splitting the 11 tools Fable5's review flagged as movable out
// of the always-bundled set (python3, sqlite3, vim, tmux, ripgrep, jq, make,
// gh, nano, unzip, less) into a scripting/dev-workflow group and an
// editing/interactive-TUI group. Grouping is a judgment call for later
// revision, not a load-bearing decision — the important part is that NONE
// of these tools are removed from the default LibExtractor.kt LIBS map by
// this change.
export const OPTIONAL_PACKS: Record<string, OptionalPackManifest> = {
  'dev-tools': {
    id: 'dev-tools',
    label: 'Dev tools',
    description: 'Scripting and dev-workflow tools: python3, sqlite3, jq, make, gh.',
    tools: ['python3', 'sqlite3', 'jq', 'make', 'gh'],
    archiveAssetName: 'shelly-pack-dev-tools-arm64.tar.gz',
    downloadUrl: placeholderDownloadUrl('shelly-pack-dev-tools-arm64.tar.gz'),
    sha256: null,
    approxSizeBytes: null,
    published: false,
  },
  'editor-tools': {
    id: 'editor-tools',
    label: 'Editor tools',
    description: 'Interactive TUI and file tools: vim, tmux, nano, less, unzip, ripgrep.',
    tools: ['vim', 'tmux', 'nano', 'less', 'unzip', 'rg'],
    archiveAssetName: 'shelly-pack-editor-tools-arm64.tar.gz',
    downloadUrl: placeholderDownloadUrl('shelly-pack-editor-tools-arm64.tar.gz'),
    sha256: null,
    approxSizeBytes: null,
    published: false,
  },
};

export function listOptionalPackIds(): string[] {
  return Object.keys(OPTIONAL_PACKS);
}

export function getOptionalPack(id: string): OptionalPackManifest | null {
  return OPTIONAL_PACKS[id] ?? null;
}

export function isValidOptionalPackId(id: string): boolean {
  return id in OPTIONAL_PACKS;
}

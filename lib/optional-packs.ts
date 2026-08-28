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
 * into jniLibs — see docs/superpowers/DEFERRED.md's item #6 entry for why
 * that step is explicitly deferred to a dedicated on-device QA pass.
 *
 * `published: true` below (2026-08-25) means the archives are real and live
 * — .github/workflows/build-android.yml's "Publish optional tool pack
 * archives" step republishes them from the same jniLibs binaries the real
 * APK ships from, on every push to main; `shelly install <pack>` can
 * genuinely download and extract them today.
 *
 * 2026-08-28: the last gap — nothing wired the extracted binaries onto
 * PATH — is closed. HomeInitializer.kt's 11 bundled-tool wrapper functions
 * (jq/sqlite3/make/gh/vim/tmux/nano/less/rg/unzip/python3) now resolve
 * their target at CALL time via a new `__shelly_tool_path()` bash helper
 * (bundled $SHELLY_LIB_DIR copy first, then $SHELLY_LIB_DIR/packs/<packId>/
 * from a `shelly install <pack>` extraction) instead of a path baked in at
 * bashrc-generation time — see BASHRC_VERSION 241's changelog comment
 * there. A pack tool becomes usable immediately after install, even in an
 * already-open terminal tab, with no new native shim (it reuses the same
 * `_run`/linker64 SELinux-exec route the bundled copies already use). Still
 * NOT done, deliberately out of scope for that change: no tool has actually
 * been removed from LibExtractor.kt's always-bundled LIBS map, so the
 * default APK size is unchanged — that removal is explicit future
 * follow-up work, not part of the PATH-wiring fix.
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
// Real release tag, published by .github/workflows/build-android.yml's
// "Publish optional tool pack archives" step on every push to main —
// confirmed live 2026-08-25 (gh release view optional-packs-latest).
const RELEASE_TAG = 'optional-packs-latest';

function releaseDownloadUrl(archiveAssetName: string): string {
  return `https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${archiveAssetName}`;
}

// Two packs, splitting the 11 tools Fable5's review flagged as movable out
// of the always-bundled set (python3, sqlite3, vim, tmux, ripgrep, jq, make,
// gh, nano, unzip, less) into a scripting/dev-workflow group and an
// editing/interactive-TUI group. Grouping is a judgment call for later
// revision, not a load-bearing decision — the important part is that NONE
// of these tools are removed from the default LibExtractor.kt LIBS map by
// this change.
//
// `sha256` is deliberately left null, not pinned to the digest of any one
// build: the CI step above republishes these archives (via --clobber) on
// EVERY push to main that reaches that step, so a hardcoded hash here would
// silently go stale the next time any of these binaries changes and start
// rejecting every future install with a false integrity failure —
// `installOptionalPack()` already treats a null sha256 as "skip the
// optional integrity check", which is the correct behavior here: transport
// is already HTTPS from GitHub's own release CDN, and the supply-chain
// trust boundary is identical to trusting the APK build itself (same repo,
// same CI, same review process), not a new weaker link. `approxSizeBytes`
// is informational-only (CLI display), so a point-in-time value confirmed
// against the live release is fine even though it too will drift slightly
// over time.
export const OPTIONAL_PACKS: Record<string, OptionalPackManifest> = {
  'dev-tools': {
    id: 'dev-tools',
    label: 'Dev tools',
    description: 'Scripting and dev-workflow tools: python3, sqlite3, jq, make, gh.',
    tools: ['python3', 'sqlite3', 'jq', 'make', 'gh'],
    archiveAssetName: 'shelly-pack-dev-tools-arm64.tar.gz',
    downloadUrl: releaseDownloadUrl('shelly-pack-dev-tools-arm64.tar.gz'),
    sha256: null,
    approxSizeBytes: 14817440,
    published: true,
  },
  'editor-tools': {
    id: 'editor-tools',
    label: 'Editor tools',
    description: 'Interactive TUI and file tools: vim, tmux, nano, less, unzip, ripgrep.',
    tools: ['vim', 'tmux', 'nano', 'less', 'unzip', 'rg'],
    archiveAssetName: 'shelly-pack-editor-tools-arm64.tar.gz',
    downloadUrl: releaseDownloadUrl('shelly-pack-editor-tools-arm64.tar.gz'),
    sha256: null,
    approxSizeBytes: 4451673,
    published: true,
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

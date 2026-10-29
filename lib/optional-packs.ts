/**
 * lib/optional-packs.ts — on-demand "optional tool pack" manifest.
 *
 * Fable5 product-review roadmap item #6: the large sideloaded APK is the
 * single biggest barrier to anyone trying Shelly cold (no Play Store
 * listing). The plan is a smaller "core" bundle plus packs fetched on demand
 * via `shelly install <pack-id>`. Today every pack tool is STILL bundled in
 * the APK as well (bundled copy wins at call time, see HomeInitializer.kt's
 * `__shelly_tool_path`), so the packs are the supported install path for
 * builds or installs that lack a tool, not yet an APK-size reduction — see
 * docs/superpowers/DEFERRED.md's item #6 entry for the slimming plan.
 *
 * Integrity (2026-10-29): every install is verified against a sha256 pinned
 * INTO THE APK at build time. CI (.github/workflows/build-android.yml,
 * "Build and publish optional tool pack archives", which runs BEFORE the APK
 * build) creates byte-reproducible archives, uploads each under a
 * content-addressed name (`shelly-pack-<id>-arm64-<sha16>.tar.gz`, never
 * overwritten), and writes `lib/optional-packs-pins.json` with the asset
 * name, sha256 and size before Metro bundles this file. The committed copy of
 * that JSON is empty, so a local/dev/PR build carries no pins and
 * `shelly install` refuses with a clear message instead of installing
 * something it cannot verify. An APK only ever downloads the exact archive it
 * was built next to; a later CI run cannot change what an existing APK
 * installs (it can only prune old assets, which surfaces as a clear
 * "update Shelly" error).
 */
import pinsJson from './optional-packs-pins.json';

export interface OptionalPackManifest {
  /** Stable, lowercase-hyphen id used on the CLI: `shelly install <id>`. */
  id: string;
  /** Short human-readable label. */
  label: string;
  /** One-sentence description of what the pack is for. */
  description: string;
  /** Binary/tool names bundled in this pack, as they'd appear once wired onto PATH. */
  tools: string[];
  /** Archive file name (.tar.gz) to download. Content-addressed once pinned. */
  archiveAssetName: string;
  /** GitHub Releases download URL for `archiveAssetName`. */
  downloadUrl: string;
  /** sha256 of the archive pinned into this build, or null when this build has no pin. */
  sha256: string | null;
  /** Exact archive size in bytes when pinned (verified), else a rough display estimate. */
  approxSizeBytes: number | null;
  /**
   * Gate: true only when CI publishes this pack AND this build carries a
   * verified pin for it. `installOptionalPack` refuses otherwise.
   */
  published: boolean;
}

export interface OptionalPackPin {
  assetName: string;
  sha256: string;
  bytes: number;
}

export interface OptionalPackPins {
  schema: number;
  source?: string;
  commit?: string;
  packs: Record<string, OptionalPackPin>;
}

const REPO = 'RYOITABASHI/Shelly';
// Rolling release that holds the pack archives, maintained by CI.
export const OPTIONAL_PACKS_RELEASE_TAG = 'optional-packs-latest';

function releaseDownloadUrl(archiveAssetName: string): string {
  return `https://github.com/${REPO}/releases/download/${OPTIONAL_PACKS_RELEASE_TAG}/${archiveAssetName}`;
}

/** Legacy (pre-pinning) un-addressed asset name, still uploaded for older builds. */
function legacyAssetName(packId: string): string {
  return `shelly-pack-${packId}-arm64.tar.gz`;
}

// Static description of each pack. `published` here means "CI builds and
// uploads this pack"; whether THIS build can install it also needs a pin
// (see resolveOptionalPack). Grouping: scripting/dev workflow vs.
// editing/interactive TUI. The tool lists must match the CI step's
// `pack_tools` map and HomeInitializer.kt's wrappers/shim list
// (__tests__/optional-packs-bashrc-sync.test.ts enforces the latter).
const STATIC_PACKS: Record<string, OptionalPackManifest> = {
  'dev-tools': {
    id: 'dev-tools',
    label: 'Dev tools',
    description: 'Scripting and dev-workflow tools: python3, sqlite3, jq, make, gh.',
    tools: ['python3', 'sqlite3', 'jq', 'make', 'gh'],
    archiveAssetName: legacyAssetName('dev-tools'),
    downloadUrl: releaseDownloadUrl(legacyAssetName('dev-tools')),
    sha256: null,
    approxSizeBytes: 23911173,
    published: true,
  },
  'editor-tools': {
    id: 'editor-tools',
    label: 'Editor tools',
    description: 'Interactive TUI and file tools: vim, tmux, nano, less, unzip, ripgrep.',
    tools: ['vim', 'tmux', 'nano', 'less', 'unzip', 'rg'],
    archiveAssetName: legacyAssetName('editor-tools'),
    downloadUrl: releaseDownloadUrl(legacyAssetName('editor-tools')),
    sha256: null,
    approxSizeBytes: 4452875,
    published: true,
  },
};

const SHA256_RE = /^[0-9a-f]{64}$/;

/** Returns the pin for `packId` only if it is well-formed; anything else is treated as "no pin". */
export function validPin(packId: string, pins: OptionalPackPins | null | undefined): OptionalPackPin | null {
  const pin = pins && pins.schema === 1 && pins.packs ? pins.packs[packId] : undefined;
  if (!pin || typeof pin !== 'object') return null;
  const { assetName, sha256, bytes } = pin;
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) return null;
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes <= 0) return null;
  const expectedName = `shelly-pack-${packId}-arm64-${sha256.slice(0, 16)}.tar.gz`;
  if (assetName !== expectedName) return null;
  return { assetName, sha256, bytes };
}

/** Pure: the static pack description with this build's pin applied. */
export function resolveOptionalPack(
  id: string,
  pins: OptionalPackPins | null | undefined
): OptionalPackManifest | null {
  const base = STATIC_PACKS[id];
  if (!base) return null;
  const pin = validPin(id, pins);
  if (!pin) {
    return { ...base, published: false };
  }
  return {
    ...base,
    archiveAssetName: pin.assetName,
    downloadUrl: releaseDownloadUrl(pin.assetName),
    sha256: pin.sha256,
    approxSizeBytes: pin.bytes,
    published: base.published,
  };
}

const BUILD_PINS = pinsJson as OptionalPackPins;

/** Pack descriptions as THIS build sees them (pins applied). */
export const OPTIONAL_PACKS: Record<string, OptionalPackManifest> = Object.fromEntries(
  Object.keys(STATIC_PACKS).map((id) => [id, resolveOptionalPack(id, BUILD_PINS)!])
);

export function listOptionalPackIds(): string[] {
  return Object.keys(OPTIONAL_PACKS);
}

export function getOptionalPack(id: string): OptionalPackManifest | null {
  return OPTIONAL_PACKS[id] ?? null;
}

export function isValidOptionalPackId(id: string): boolean {
  return id in OPTIONAL_PACKS;
}

/** tool name -> pack id, for "command not found" hints. */
export function packForTool(tool: string): string | null {
  for (const pack of Object.values(OPTIONAL_PACKS)) {
    if (pack.tools.includes(tool)) return pack.id;
  }
  return null;
}

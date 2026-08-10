/**
 * components/layout/BuildsModal.tsx — runtime validation of untrusted GitHub
 * Actions API / release-manifest JSON.
 *
 * This surface feeds the app's self-update/install flow (BuildsModal fetches
 * workflow runs and release assets, then downloads + installs an APK), so a
 * response shape the API didn't promise (missing field, wrong type, a
 * non-object array entry) must be skipped instead of thrown as a runtime
 * TypeError deep inside a bare `.map((x: any) => ...)`. mapApiRuns/
 * toGitHubReleaseAsset/parseGitHubReleaseAssets are the type guards that
 * replaced the old `any`-typed parsing; this suite feeds them adversarial
 * payloads (wrong types, missing fields, non-object array entries) and pins
 * that malformed entries are dropped, not crashed on.
 */
import { mapApiRuns, toGitHubReleaseAsset, parseGitHubReleaseAssets } from '@/components/layout/BuildsModal';

// BuildsModal.tsx pulls in the native TerminalEmulator module (for the
// installed-app-version probe and installApk) at module load time via
// requireNativeModule(), which throws outside a real native runtime. Stub it
// out — none of the functions under test touch it.
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: {},
}));

// AsyncStorage's native module is unavailable under Jest; use the package's
// own official mock (same pattern as __tests__/settings-store-social-
// connector-update.test.tsx) rather than reaching into internals.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('mapApiRuns (GitHub Actions workflow_runs response)', () => {
  it('maps a well-formed run', () => {
    const runs = mapApiRuns({
      workflow_runs: [
        {
          id: 123,
          run_number: 7,
          status: 'completed',
          conclusion: 'success',
          display_title: 'fix: thing',
          head_sha: 'abcdef',
          created_at: '2026-08-01T00:00:00Z',
          run_started_at: '2026-08-01T00:00:01Z',
          updated_at: '2026-08-01T00:05:00Z',
          html_url: 'https://github.com/example/run/123',
        },
      ],
    });
    expect(runs).toEqual([
      {
        databaseId: 123,
        number: 7,
        status: 'completed',
        conclusion: 'success',
        displayTitle: 'fix: thing',
        headSha: 'abcdef',
        createdAt: '2026-08-01T00:00:00Z',
        startedAt: '2026-08-01T00:00:01Z',
        updatedAt: '2026-08-01T00:05:00Z',
        url: 'https://github.com/example/run/123',
      },
    ]);
  });

  it('falls back to defaults for a sparse-but-valid run', () => {
    const runs = mapApiRuns({ workflow_runs: [{ id: 9 }] });
    expect(runs).toEqual([
      {
        databaseId: 9,
        number: undefined,
        status: 'unknown',
        conclusion: null,
        displayTitle: 'Run #9',
        headSha: '',
        createdAt: '',
        startedAt: '',
        updatedAt: '',
        url: '',
      },
    ]);
  });

  it('drops a run with no usable id instead of crashing', () => {
    expect(mapApiRuns({ workflow_runs: [{ status: 'completed' }] })).toEqual([]);
  });

  it('drops non-object entries in workflow_runs (string/number/null/array)', () => {
    const runs = mapApiRuns({
      workflow_runs: ['oops', 42, null, [1, 2], { id: 1 }],
    });
    expect(runs).toEqual([
      expect.objectContaining({ databaseId: 1 }),
    ]);
  });

  it('returns [] when workflow_runs is missing or the wrong type', () => {
    expect(mapApiRuns({})).toEqual([]);
    expect(mapApiRuns({ workflow_runs: 'not-an-array' })).toEqual([]);
    expect(mapApiRuns({ workflow_runs: null })).toEqual([]);
  });

  it('returns [] for a payload that is not an object at all (null/string/array/number)', () => {
    expect(mapApiRuns(null)).toEqual([]);
    expect(mapApiRuns(undefined)).toEqual([]);
    expect(mapApiRuns('not json')).toEqual([]);
    expect(mapApiRuns(42)).toEqual([]);
    expect(mapApiRuns([{ id: 1 }])).toEqual([]);
  });

  it('accepts a numeric-string id and coerces it', () => {
    const runs = mapApiRuns({ workflow_runs: [{ id: '55' }] });
    expect(runs).toEqual([expect.objectContaining({ databaseId: 55, displayTitle: 'Run #55' })]);
  });
});

describe('toGitHubReleaseAsset / parseGitHubReleaseAssets (GitHub release assets response)', () => {
  it('parses a well-formed asset', () => {
    const asset = toGitHubReleaseAsset({
      name: 'shelly.apk',
      size: 12345,
      browser_download_url: 'https://example.com/shelly.apk',
    });
    expect(asset).toEqual({
      name: 'shelly.apk',
      size: 12345,
      browser_download_url: 'https://example.com/shelly.apk',
    });
  });

  it('rejects an asset missing a required field (name or url)', () => {
    expect(toGitHubReleaseAsset({ size: 1, browser_download_url: 'https://x' })).toBeNull();
    expect(toGitHubReleaseAsset({ name: 'x.apk' })).toBeNull();
  });

  it('rejects an asset whose required fields have the wrong type', () => {
    expect(toGitHubReleaseAsset({ name: 42, browser_download_url: 'https://x' })).toBeNull();
    expect(toGitHubReleaseAsset({ name: 'x.apk', browser_download_url: null })).toBeNull();
  });

  it('drops a non-finite/non-numeric size instead of propagating garbage', () => {
    const asset = toGitHubReleaseAsset({
      name: 'x.apk',
      size: Number.POSITIVE_INFINITY,
      browser_download_url: 'https://x',
    });
    expect(asset?.size).toBeUndefined();
  });

  it('rejects non-object input', () => {
    expect(toGitHubReleaseAsset(null)).toBeNull();
    expect(toGitHubReleaseAsset('asset')).toBeNull();
    expect(toGitHubReleaseAsset(42)).toBeNull();
  });

  it('parseGitHubReleaseAssets skips malformed entries and keeps valid ones', () => {
    const assets = parseGitHubReleaseAssets([
      { name: 'good.apk', browser_download_url: 'https://x/good.apk' },
      { name: 'no-url.apk' },
      'garbage',
      null,
      { browser_download_url: 'https://x/no-name' },
    ]);
    expect(assets).toEqual([{ name: 'good.apk', size: undefined, browser_download_url: 'https://x/good.apk' }]);
  });

  it('parseGitHubReleaseAssets returns [] for non-array input', () => {
    expect(parseGitHubReleaseAssets(undefined)).toEqual([]);
    expect(parseGitHubReleaseAssets({ assets: [] })).toEqual([]);
  });
});

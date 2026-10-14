import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require('../plugins/with-release-signing.js');
const { applyReleaseSigning, MARKER } = plugin as {
  applyReleaseSigning: (src: string) => string;
  MARKER: string;
};

const ROOT = path.resolve(__dirname, '..');

// Minimal reproduction of the Expo SDK 54 app/build.gradle template sections
// the plugin patches (the stock template signs release with the debug key).
const TEMPLATE = `apply plugin: "com.android.application"

def enableMinifyInReleaseBuilds = false

android {
    namespace 'dev.shelly.terminal'
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}
`;

function releaseBuildTypeBody(gradle: string): string {
  const buildTypes = gradle.slice(gradle.indexOf('buildTypes {'));
  const start = buildTypes.indexOf('release {');
  expect(start).toBeGreaterThan(-1);
  return buildTypes.slice(start, buildTypes.indexOf('}', start));
}

describe('plugins/with-release-signing', () => {
  const out = applyReleaseSigning(TEMPLATE);

  it('defines a release signingConfig fed only from SHELLY_RELEASE_* values', () => {
    expect(out).toMatch(/if \(shellyUseReleaseSigning\) \{\s*release \{/);
    expect(out).toContain('storeFile new File(shellyReleaseStoreFile)');
    expect(out).toContain('keyAlias shellyReleaseKeyAlias');
    for (const name of [
      'SHELLY_SIGNING_MODE',
      'SHELLY_RELEASE_STORE_FILE',
      'SHELLY_RELEASE_STORE_PASSWORD',
      'SHELLY_RELEASE_KEY_ALIAS',
      'SHELLY_RELEASE_KEY_PASSWORD',
    ]) {
      expect(out).toContain(`shellySigningValue('${name}')`);
    }
  });

  it('release buildType no longer hard-wires the debug key', () => {
    const body = releaseBuildTypeBody(out);
    expect(body).not.toMatch(/signingConfig\s+signingConfigs\.debug\s*$/m);
    expect(body).toContain(
      'signingConfig shellyLeaveReleaseUnsigned ? null : (shellyUseReleaseSigning ? signingConfigs.release : signingConfigs.debug)',
    );
  });

  it('rotation mode leaves the release APK unsigned for the CI apksigner v3-rotation step', () => {
    expect(out).toContain("def shellyLeaveReleaseUnsigned = shellySigningMode == 'rotation'");
  });

  it('keeps the debug buildType on the debug key (local dev builds)', () => {
    const debugBuildType = out.slice(out.indexOf('buildTypes {'), out.indexOf('release {', out.indexOf('buildTypes {')));
    expect(debugBuildType).toContain('signingConfig signingConfigs.debug');
  });

  it('fails closed: release mode without a complete keystore, or CI without a mode, throws', () => {
    expect(out).toContain('SHELLY_SIGNING_MODE=release but release signing is not configured');
    expect(out).toContain('SHELLY_SIGNING_MODE=release but SHELLY_RELEASE_STORE_FILE does not exist');
    expect(out).toContain("SHELLY_SIGNING_MODE is required on CI; refusing to fall back to the public debug keystore");
    expect(out).toMatch(/!\(shellySigningMode in \['release', 'rotation', 'legacy-debug'\]\)/);
    // The only ways to the debug key on a release build are an explicit
    // legacy-debug mode or an unset mode outside CI.
    expect(out).toContain("def shellyUseReleaseSigning = shellySigningMode == 'release'");
  });

  it('places the prelude before android { so the defs are in scope', () => {
    expect(out.indexOf(`${MARKER} begin`)).toBeLessThan(out.indexOf('\nandroid {'));
  });

  it('is idempotent', () => {
    expect(applyReleaseSigning(out)).toBe(out);
  });

  it('throws instead of silently skipping when the template changes', () => {
    expect(() => applyReleaseSigning(TEMPLATE.replace(/signingConfigs \{[\s\S]*?\n    \}\n/, ''))).toThrow(
      /signingConfigs/,
    );
    expect(() =>
      applyReleaseSigning(TEMPLATE.replace(/release \{[\s\S]*?\n        \}/, 'release {\n        }')),
    ).toThrow(/buildTypes\.release/);
  });

  it('is registered in app.config.ts and already applied to the checked-in build.gradle', () => {
    const appConfig = fs.readFileSync(path.join(ROOT, 'app.config.ts'), 'utf8');
    expect(appConfig).toContain('"./plugins/with-release-signing"');
    const gradle = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8');
    expect(gradle).toContain(`${MARKER} begin`);
    expect(applyReleaseSigning(gradle)).toBe(gradle);
    expect(releaseBuildTypeBody(gradle)).toContain('shellyUseReleaseSigning ? signingConfigs.release');
  });
});

describe('build-android.yml signing gates', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/build-android.yml'), 'utf8');

  it('offers a signing input with release and legacy-debug choices', () => {
    expect(workflow).toMatch(
      /signing:\s*\n\s*description:[\s\S]*?options:\s*\n\s*- default\s*\n\s*- rotation\s*\n\s*- release\s*\n\s*- legacy-debug/,
    );
  });

  it('rotation mode signs with apksigner v3 lineage (debug -> release, API 28+) and verifies it', () => {
    expect(workflow).toContain("if: ${{ env.SHELLY_SIGNING_MODE == 'rotation' }}");
    expect(workflow).toContain('--next-signer --ks "${keystore}" --ks-type pkcs12');
    expect(workflow).toContain('--lineage signing/shelly-signing-lineage.bin --rotation-min-sdk-version 28');
    expect(workflow).toContain('Verified using v3 scheme (APK Signature Scheme v3): true');
    expect(workflow).toMatch(/FATAL: APK v3 lineage .* is not debug -> release/);
    expect(workflow).toContain('FATAL: release APK is unsigned');
  });

  it('rotation check workflow revokes every old-signer capability except installed-data', () => {
    const check = fs.readFileSync(path.join(ROOT, '.github/workflows/signing-rotation-check.yml'), 'utf8');
    expect(check).toContain(
      '--set-installed-data true --set-shared-uid false --set-permission false --set-rollback false --set-auth false',
    );
    expect(check).toContain('bash scripts/signing/rotation-emulator-test.sh');
    const script = fs.readFileSync(path.join(ROOT, 'scripts/signing/rotation-emulator-test.sh'), 'utf8');
    expect(script).toContain('expect_install "${work}/v3-debug.apk" INSTALL_FAILED_UPDATE_INCOMPATIBLE');
    expect(script).toContain('expect_install "${work}/v2-rotation.apk" success');
  });

  it('pins both the new release and the legacy debug certificate fingerprints', () => {
    expect(workflow).toContain('SHELLY_RELEASE_CERT_SHA256: 1476d9520a49bf8da7a767cb413918ccd5c5fcd7f62603766af6521f30de212d');
    expect(workflow).toContain('SHELLY_LEGACY_DEBUG_CERT_SHA256: fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c');
  });

  it('decodes the keystore from secrets and fails when they are missing in release mode', () => {
    expect(workflow).toContain('secrets.SHELLY_RELEASE_KEYSTORE_B64');
    expect(workflow).toMatch(/FATAL: release signing secrets are missing/);
  });

  it('verifies the built APK signer with apksigner against the expected fingerprint', () => {
    expect(workflow).toContain('"${apksigner}" verify -v --print-certs');
    expect(workflow).toMatch(/FATAL: APK signer .* does not match expected/);
  });

  it('keeps the keystore out of the Gradle build in rotation mode and cleans it up', () => {
    // passwords reach Gradle only in release-only mode
    expect(workflow).toContain(
      "SHELLY_RELEASE_STORE_PASSWORD: ${{ env.SHELLY_SIGNING_MODE == 'release' && secrets.SHELLY_RELEASE_KEYSTORE_PASSWORD || '' }}",
    );
    expect(workflow).toContain('--key-pass env:SHELLY_RELEASE_KEY_PASSWORD');
    expect(workflow).toMatch(/- name: Remove release keystore\n\s*if: always\(\)/);
    // rotation decodes the keystore inside the post-build signing step only
    const resolve = workflow.slice(workflow.indexOf('- name: Resolve APK signing key'), workflow.indexOf('- name: Build APK'));
    expect(resolve).toMatch(/if \[ "\$\{mode\}" = "rotation" \]; then[\s\S]*?else[\s\S]*?base64 -d/);
  });

  it('enters the release-signing environment consistently with the default signing mode', () => {
    const defaultMode = /SHELLY_DEFAULT_SIGNING_MODE: (\S+)/.exec(workflow)?.[1];
    const envLine = /\n    environment: (.*)\n/.exec(workflow)?.[1] ?? '';
    if (defaultMode === 'legacy-debug') {
      expect(envLine).toBe("${{ (inputs.signing == 'rotation' || inputs.signing == 'release') && 'release-signing' || '' }}");
    } else {
      // a key-needing default must enter the environment for push / default runs
      expect(envLine).toBe("${{ inputs.signing != 'legacy-debug' && 'release-signing' || '' }}");
    }
    const check = fs.readFileSync(path.join(ROOT, '.github/workflows/signing-rotation-check.yml'), 'utf8');
    expect(check).toContain('    environment: release-signing\n');
  });

  it('never publishes a release-only (no lineage) APK to an update channel', () => {
    expect(workflow).toContain('FATAL: refusing to publish a release-only (no lineage) APK to an update channel');
  });

  it('records the signing certificate in the update manifest', () => {
    expect(workflow).toContain('signingCertSha256: process.env.SIGNING_CERT_SHA256');
  });
});

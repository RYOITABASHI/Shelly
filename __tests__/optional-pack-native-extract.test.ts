/**
 * Source-assertion test for the native side of `shelly install <pack>`
 * (LibExtractor.extractPack + its bridge). Kotlin is not compiled in this
 * JS toolchain, so — like optional-packs-bashrc-sync.test.ts — this pins the
 * security-relevant shape so a later edit cannot silently drop it:
 *   - the pinned sha256 + size reach native code, which verifies a PRIVATE
 *     copy before listing/extracting it;
 *   - tar entries are listed first and only regular files / directories with
 *     safe relative paths are allowed;
 *   - nothing in the pack install path uses File.deleteRecursively (which
 *     follows symlinked directories); an interrupted swap is restored.
 */
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '..');
const kdir = path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator');
const lib = fs.readFileSync(path.join(kdir, 'LibExtractor.kt'), 'utf8');
const mod = fs.readFileSync(path.join(kdir, 'TerminalEmulatorModule.kt'), 'utf8');

function region(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

const packRegion = region(lib, 'data class PackExtractionResult', 'private fun extractTarGzAsset(');

describe('native pack extraction invariants', () => {
  it('the bridge passes the pinned sha256 and size into LibExtractor.extractPack', () => {
    expect(mod).toMatch(
      /AsyncFunction\("extractPackArchive"\) \{ packId: String, archivePath: String, tools: List<String>, expectedSha256: String, expectedSizeBytes: Long ->/
    );
    expect(mod).toContain('LibExtractor.extractPack(context, packId, archivePath, tools, expectedSha256.lowercase(), expectedSizeBytes)');
  });

  it('copies into app-private storage and verifies the copy before listing and extracting it', () => {
    const body = region(packRegion, 'fun extractPack(', 'private fun recoverInterruptedPackSwap');
    const copy = body.indexOf('copyAndVerify(archive, privateCopy, expectedSha256, expectedSizeBytes, packId)');
    const list = body.indexOf('validatePackTarEntries(privateCopy, packId)');
    const tar = body.indexOf('"/system/bin/tar", "xzf", privateCopy.absolutePath');
    expect(copy).toBeGreaterThan(0);
    expect(list).toBeGreaterThan(copy);
    expect(tar).toBeGreaterThan(list);
    // The downloaded (external) archive is never handed to tar.
    expect(body).not.toContain('archive.absolutePath, "-C"');
  });

  it('allows only regular files and directories with relative, ..-free paths', () => {
    const v = region(packRegion, 'internal fun validatePackTarEntries', 'private fun readFully');
    expect(v).toContain("'0', '\\u0000', '5' -> Unit");
    expect(v).toContain('disallowed entry type');
    expect(v).toContain('name.startsWith("/")');
    expect(v).toContain('name.split(\'/\').any { it == ".." }');
  });

  it('never uses deleteRecursively in the pack install path, and restores an interrupted swap', () => {
    expect(packRegion).not.toContain('deleteRecursively()');
    expect(packRegion).toContain('internal fun deleteTreeNoFollow(root: File)');
    const rec = region(packRegion, 'private fun recoverInterruptedPackSwap', 'private fun copyAndVerify');
    expect(rec).toContain('if (!packDir.exists() && olds.isNotEmpty())');
    expect(rec).toContain('olds.first().renameTo(packDir)');
    // .old-* is only cleaned once packDir exists again.
    expect(rec).toContain('(n.startsWith(".old-$packId-") && packDir.exists())');
  });
});

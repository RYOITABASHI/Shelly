import * as fs from 'node:fs';
import * as path from 'node:path';

// Sidebar / AgentBar read the live palette (`colors as C`) in their styles.
// A module-level StyleSheet.create snapshots the seed palette at import time,
// so preset swaps never reached them; they must use createThemedStyles.
describe('layout chrome follows the active theme preset', () => {
  for (const file of ['components/layout/Sidebar.tsx', 'components/layout/AgentBar.tsx']) {
    it(`${file} uses createThemedStyles, not a frozen StyleSheet.create`, () => {
      const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
      expect(src).toContain("from '@/lib/themed-stylesheet'");
      expect(src).toMatch(/const styles = createThemedStyles\(\(\) => \(\{/);
      expect(src).not.toMatch(/StyleSheet\.create\(/);
    });
  }
});

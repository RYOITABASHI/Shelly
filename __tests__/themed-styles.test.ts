jest.mock('react-native', () => ({
  StyleSheet: { create: <T,>(s: T) => s },
}));

import { themedStyleSheet } from '@/lib/themed-styles';
import { useThemeVersionStore } from '@/store/theme-version-store';

describe('themedStyleSheet', () => {
  it('rebuilds styles from the live palette after a theme version bump', () => {
    const palette = { text1: '#000000' };
    const factory = jest.fn(() => ({ label: { color: palette.text1 } }));
    const styles = themedStyleSheet(factory);

    expect(factory).not.toHaveBeenCalled();
    expect(styles.label.color).toBe('#000000');

    palette.text1 = '#FFFFFF';
    // Same version: cached sheet is reused, mirroring StyleSheet semantics.
    expect(styles.label.color).toBe('#000000');
    expect(factory).toHaveBeenCalledTimes(1);

    useThemeVersionStore.getState().bumpVersion();
    expect(styles.label.color).toBe('#FFFFFF');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('supports spreading and key enumeration', () => {
    const styles = themedStyleSheet(() => ({ a: { flex: 1 }, b: { flex: 2 } }));
    expect(Object.keys(styles)).toEqual(['a', 'b']);
    expect({ ...styles }).toEqual({ a: { flex: 1 }, b: { flex: 2 } });
    expect('a' in styles).toBe(true);
  });
});

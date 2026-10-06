import { formatContextBarPath, tildifyPath } from '@/lib/context-bar-path';

const HOME_USER0 = '/data/user/0/dev.shelly.terminal/files/home';
const HOME_DATA = '/data/data/dev.shelly.terminal/files/home';

describe('ContextBar path display', () => {
  it('shows ~ for the home dir under either Android data-dir alias', () => {
    expect(tildifyPath(HOME_DATA, HOME_USER0)).toBe('~');
    expect(tildifyPath(HOME_USER0, HOME_DATA)).toBe('~');
    expect(tildifyPath(HOME_USER0 + '/', HOME_USER0)).toBe('~');
    expect(formatContextBarPath(HOME_DATA, HOME_USER0)).toBe('~');
  });

  it('shows ~-relative paths below home', () => {
    expect(tildifyPath(`${HOME_DATA}/repos/Shelly`, HOME_USER0)).toBe('~/repos/Shelly');
  });

  it('does not tildify a sibling that merely shares the home prefix', () => {
    expect(tildifyPath(`${HOME_DATA}2/x`, HOME_USER0)).toBe(`${HOME_DATA}2/x`);
  });

  it('left-truncates long paths with a single ellipsis glyph', () => {
    const out = formatContextBarPath('/sdcard/Download/some/very/deep/project/dir', HOME_USER0, 20);
    expect(out).toHaveLength(20);
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('project/dir')).toBe(true);
  });
});

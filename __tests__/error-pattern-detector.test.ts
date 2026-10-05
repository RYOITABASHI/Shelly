import { detectErrors } from '@/lib/error-pattern-detector';

describe('detectErrors', () => {
  it('returns an empty list when nothing matches', () => {
    expect(detectErrors('')).toEqual([]);
    expect(detectErrors('Build succeeded in 1.2s\nNo errors found.')).toEqual([]);
  });

  it('detects an absolute file:line:col location (tsc/gcc/eslint/rustc style)', () => {
    const text = '/home/user/app/src/index.ts:12:5 - error TS2322: Type mismatch';
    expect(detectErrors(text)).toEqual([
      {
        text: '/home/user/app/src/index.ts:12:5',
        filePath: '/home/user/app/src/index.ts',
        line: 12,
        col: 5,
        start: 0,
        end: 32,
      },
    ]);
  });

  it('reports character offsets relative to the input', () => {
    const prefix = 'error: ';
    const text = `${prefix}/tmp/a.c:3:9: expected semicolon`;
    const [match] = detectErrors(text);
    expect(match.start).toBe(prefix.length);
    expect(text.slice(match.start, match.end)).toBe('/tmp/a.c:3:9');
  });

  // Known limitation: the file:line:col pattern only anchors on `/`, so a
  // relative location like `src/app.ts:3:1` is matched from its last slash
  // and reported as `/app.ts`. Pinned here so a fix is a deliberate change.
  it('truncates relative file:line:col locations to their last path segment', () => {
    expect(detectErrors('src/app.ts:3:1 error')).toEqual([
      { text: '/app.ts:3:1', filePath: '/app.ts', line: 3, col: 1, start: 3, end: 14 },
    ]);
    expect(detectErrors('app.ts:3:1 error')).toEqual([]);
  });

  it('detects multiple locations in multi-line output', () => {
    const text = ['/a/one.ts:1:2 error', 'ok line', '/b/two.rs:30:4 warning'].join('\n');
    expect(detectErrors(text).map((e) => [e.filePath, e.line, e.col])).toEqual([
      ['/a/one.ts', 1, 2],
      ['/b/two.rs', 30, 4],
    ]);
  });

  it('detects Python traceback frames without a column', () => {
    const text = [
      'Traceback (most recent call last):',
      '  File "/home/user/script.py", line 42, in main',
    ].join('\n');
    const results = detectErrors(text);
    expect(results).toEqual([
      expect.objectContaining({
        text: 'File "/home/user/script.py", line 42',
        filePath: '/home/user/script.py',
        line: 42,
      }),
    ]);
    expect(results[0].col).toBeUndefined();
  });

  it('accepts relative paths in Python traceback frames', () => {
    const [match] = detectErrors('File "app/main.py", line 7, in <module>');
    expect(match).toEqual(expect.objectContaining({ filePath: 'app/main.py', line: 7 }));
  });

  // A Node stack frame also satisfies the generic file:line:col pattern, so it
  // is currently reported twice (once per pattern) with the same location.
  it('detects Node.js stack frames', () => {
    const text = '    at Object.<anonymous> (/home/user/app/server.js:10:15)';
    const results = detectErrors(text);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r).toEqual(
        expect.objectContaining({ filePath: '/home/user/app/server.js', line: 10, col: 15 }),
      );
    }
    expect(results.some((r) => r.text.startsWith('at '))).toBe(true);
  });

  it('detects webpack "ERROR in" paths without line info', () => {
    const [match] = detectErrors('ERROR in ./src/components/App.tsx\nModule not found');
    expect(match).toEqual(
      expect.objectContaining({
        text: 'ERROR in ./src/components/App.tsx',
        filePath: './src/components/App.tsx',
      }),
    );
    expect(match.line).toBeUndefined();
    expect(match.col).toBeUndefined();
  });

  it('is stable across repeated calls (global regex state is reset)', () => {
    const text = '/x/y.ts:1:1';
    expect(detectErrors(text)).toHaveLength(1);
    expect(detectErrors(text)).toHaveLength(1);
  });
});

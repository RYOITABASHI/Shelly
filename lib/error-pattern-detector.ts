export type DetectedError = {
  text: string;       // matched text
  filePath: string;
  line?: number;
  col?: number;
  start: number;      // char offset in input
  end: number;
};

const ERROR_PATTERNS: { regex: RegExp; extract: (m: RegExpExecArray) => Omit<DetectedError, 'text' | 'start' | 'end'> }[] = [
  // file:line:col (GCC, TypeScript, ESLint, Rust)
  { regex: /((?:\/[\w._-]+)+\.\w+):(\d+):(\d+)/g, extract: (m) => ({ filePath: m[1], line: +m[2], col: +m[3] }) },
  // Python traceback: File "path", line N
  { regex: /File "([^"]+)", line (\d+)/g, extract: (m) => ({ filePath: m[1], line: +m[2] }) },
  // Node.js: at ... (file:line:col)
  { regex: /at\s+.*?\(?((?:\/[\w._-]+)+\.\w+):(\d+):(\d+)\)?/g, extract: (m) => ({ filePath: m[1], line: +m[2], col: +m[3] }) },
  // webpack: ERROR in ./path
  { regex: /ERROR in ((?:\.\/|\/)?[\w.\/_-]+\.\w+)/g, extract: (m) => ({ filePath: m[1] }) },
];

export function detectErrors(text: string): DetectedError[] {
  const results: DetectedError[] = [];
  for (const { regex, extract } of ERROR_PATTERNS) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const data = extract(m);
      results.push({ text: m[0], start: m.index, end: m.index + m[0].length, ...data });
    }
  }
  return results;
}

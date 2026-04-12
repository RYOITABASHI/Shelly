/**
 * lib/syntax-highlight.ts — Lightweight keyword-based syntax highlighting
 *
 * Returns an array of styled segments for a single line of code.
 * No heavy library — regex-based keyword/string/comment detection.
 */

export type TokenType = 'keyword' | 'string' | 'comment' | 'number' | 'punctuation' | 'default';

export type Token = {
  text: string;
  type: TokenType;
};

// --- Color Map ------------------------------------------------------------------

// Mock-faithful palette. Keywords land on the same purple Shelly uses for
// the CLAUDE role label so code blocks read as "same family" as the AI
// pane. Strings pop in pink, numbers in amber.
export const TOKEN_COLORS: Record<TokenType, string> = {
  keyword:     '#A78BFA', // purple — import/from/const/function/return
  string:      '#EC4899', // pink — 'react', "react-native"
  comment:     '#6B7280', // slate-500
  number:      '#F59E0B', // amber
  punctuation: '#6B7280',
  default:     '#E5E7EB',
};

// --- Keyword Sets ---------------------------------------------------------------

const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'class', 'extends', 'import', 'export', 'from', 'default', 'new', 'this',
  'async', 'await', 'try', 'catch', 'throw', 'typeof', 'instanceof',
  'true', 'false', 'null', 'undefined', 'void', 'type', 'interface',
  'enum', 'implements', 'readonly', 'as', 'in', 'of', 'switch', 'case', 'break',
]);

const PYTHON_KEYWORDS = new Set([
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import',
  'from', 'as', 'try', 'except', 'finally', 'raise', 'with', 'yield',
  'True', 'False', 'None', 'and', 'or', 'not', 'in', 'is', 'lambda',
  'pass', 'break', 'continue', 'global', 'nonlocal', 'async', 'await',
]);

const KOTLIN_KEYWORDS = new Set([
  'fun', 'val', 'var', 'class', 'object', 'interface', 'return', 'if', 'else',
  'when', 'for', 'while', 'import', 'package', 'override', 'open', 'abstract',
  'data', 'sealed', 'companion', 'suspend', 'null', 'true', 'false',
  'is', 'as', 'in', 'by', 'private', 'public', 'internal', 'protected',
]);

const CSS_KEYWORDS = new Set([
  'display', 'flex', 'grid', 'position', 'margin', 'padding', 'border',
  'color', 'background', 'font-size', 'font-weight', 'width', 'height',
  'top', 'left', 'right', 'bottom', 'z-index', 'overflow', 'opacity',
  'transition', 'animation', 'transform', 'box-shadow', 'text-align',
]);

const LANGUAGE_KEYWORDS: Record<string, Set<string>> = {
  typescript: JS_KEYWORDS,
  javascript: JS_KEYWORDS,
  python: PYTHON_KEYWORDS,
  kotlin: KOTLIN_KEYWORDS,
  java: KOTLIN_KEYWORDS, // close enough
  css: CSS_KEYWORDS,
};

// --- Tokenizer ------------------------------------------------------------------

export function tokenizeLine(line: string, language: string): Token[] {
  const keywords = LANGUAGE_KEYWORDS[language];
  if (!keywords) {
    return [{ text: line, type: 'default' }];
  }

  const tokens: Token[] = [];
  let i = 0;

  while (i < line.length) {
    // Comments: // or #
    if ((line[i] === '/' && line[i + 1] === '/') || (language === 'python' && line[i] === '#')) {
      tokens.push({ text: line.slice(i), type: 'comment' });
      break;
    }

    // Strings: "..." or '...' or `...`
    if (line[i] === '"' || line[i] === "'" || line[i] === '`') {
      const quote = line[i];
      let j = i + 1;
      while (j < line.length && line[j] !== quote) {
        if (line[j] === '\\') j++; // skip escaped
        j++;
      }
      tokens.push({ text: line.slice(i, j + 1), type: 'string' });
      i = j + 1;
      continue;
    }

    // Numbers
    if (/\d/.test(line[i]) && (i === 0 || /[\s(,=:+\-*/]/.test(line[i - 1]))) {
      let j = i;
      while (j < line.length && /[\d.xXa-fA-F]/.test(line[j])) j++;
      tokens.push({ text: line.slice(i, j), type: 'number' });
      i = j;
      continue;
    }

    // Words (potential keywords)
    if (/[a-zA-Z_$]/.test(line[i])) {
      let j = i;
      while (j < line.length && /[a-zA-Z0-9_$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      tokens.push({ text: word, type: keywords.has(word) ? 'keyword' : 'default' });
      i = j;
      continue;
    }

    // Punctuation
    if (/[{}()\[\];:,.<>=+\-*/&|!?@%^~]/.test(line[i])) {
      tokens.push({ text: line[i], type: 'punctuation' });
      i++;
      continue;
    }

    // Whitespace and other
    let j = i;
    while (j < line.length && !/[a-zA-Z0-9_$"'`{}()\[\];:,.<>=+\-*/&|!?@%^~#/]/.test(line[j])) j++;
    if (j > i) {
      tokens.push({ text: line.slice(i, j), type: 'default' });
      i = j;
    } else {
      tokens.push({ text: line[i], type: 'default' });
      i++;
    }
  }

  return tokens;
}

export type TokenType = 'command' | 'flag' | 'string' | 'pipe' | 'path' | 'variable' | 'plain';
export type Token = { text: string; type: TokenType };

export const TOKEN_COLORS: Record<TokenType, string> = {
  command: '#00D4AA',  // accent green
  flag: '#56B6C2',    // cyan
  string: '#E5C07B',  // yellow
  pipe: '#E06C75',    // red
  path: '#61AFEF',    // blue
  variable: '#C678DD', // magenta
  plain: '#ECEDEE',   // default
};

// Regex patterns for token classification
const PIPE_RE = /^(\|{1,2}|&&|;)$/;
const FLAG_RE = /^--?[a-zA-Z][\w-]*/;
const VARIABLE_RE = /^\$\w+/;
const PATH_RE = /^(\/|\.\/|~\/)\S*/;
const QUOTED_RE = /^(['"`]).*?\1/s;

/**
 * Tokenizes a shell input string into typed tokens.
 *
 * Strategy:
 *   - Walk character-by-character, splitting on whitespace (preserving spaces as plain tokens).
 *   - Track `isFirst` so the first non-space, non-pipe word is classified as 'command'.
 *   - After a pipe operator, reset isFirst so the next word is also a 'command'.
 *   - Quoted strings are extracted as single tokens including the quotes.
 */
export function tokenize(input: string): Token[] {
  if (!input) return [];

  const tokens: Token[] = [];
  let i = 0;
  let isFirst = true;

  while (i < input.length) {
    // Consume leading whitespace as a plain token to preserve spacing for the overlay.
    if (input[i] === ' ' || input[i] === '\t') {
      let ws = '';
      while (i < input.length && (input[i] === ' ' || input[i] === '\t')) {
        ws += input[i++];
      }
      tokens.push({ text: ws, type: 'plain' });
      continue;
    }

    // Quoted string: greedily match to closing quote (same quote char).
    if (input[i] === '"' || input[i] === "'" || input[i] === '`') {
      const quote = input[i];
      let j = i + 1;
      while (j < input.length && input[j] !== quote) {
        if (input[j] === '\\') j++; // skip escaped char
        j++;
      }
      if (j < input.length) j++; // include closing quote
      const word = input.slice(i, j);
      tokens.push({ text: word, type: 'string' });
      i = j;
      continue;
    }

    // Collect a "word" (non-whitespace, non-quote).
    let j = i;
    while (j < input.length && input[j] !== ' ' && input[j] !== '\t' &&
           input[j] !== '"' && input[j] !== "'" && input[j] !== '`') {
      j++;
    }
    const word = input.slice(i, j);
    i = j;

    if (!word) continue;

    let type: TokenType;

    if (PIPE_RE.test(word)) {
      // Pipe / logical operator — next real token becomes a command again.
      type = 'pipe';
      isFirst = true;
    } else if (VARIABLE_RE.test(word)) {
      type = 'variable';
    } else if (isFirst) {
      // First real (non-pipe) word is the command.
      type = 'command';
      isFirst = false;
    } else if (FLAG_RE.test(word)) {
      type = 'flag';
    } else if (PATH_RE.test(word)) {
      type = 'path';
    } else {
      type = 'plain';
    }

    tokens.push({ text: word, type });
  }

  return tokens;
}

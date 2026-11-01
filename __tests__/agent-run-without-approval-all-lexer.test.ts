/**
 * "承認なしで実行（すべて）" — quote-aware lexing, scratch dirs and $TMPDIR
 * (2026-11-02, on-device build 2790: a Claude Code worker in an attended
 * "all"-level run still asked for four routine commands).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  escalationAutoApprovable,
  lexAllLevelScript,
  type EscalationAutoApproveOpts,
} from '@/lib/agent-run-without-approval';
import { classifyProposedCommand } from '@/lib/agent-boundary-policy';

const ROOT = path.resolve(__dirname, '..');
const HOME = '/data/user/0/dev.shelly.terminal/files/home';
const HOME_PATHS = [HOME, '/data/data/dev.shelly.terminal/files/home'];
const WS = `${HOME}/demo`;
const CS = `${HOME}/projects/shelly-content-studio`;

const allOpts: EscalationAutoApproveOpts = {
  enabled: true,
  trustedWorkspaceRoot: WS,
  homePaths: HOME_PATHS,
  level: 'all',
  attended: true,
};

/** Answered without a human: by this module, or the gate allowed it outright. */
const ANSWERED = expect.objectContaining({ ok: true });

const sq = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;

/** What a human would be asked, and what each level answers. A command the
 *  gate does not hand to a human at all reports `gate:<decision>`. */
function judge(command: string, opts: Partial<EscalationAutoApproveOpts> = {}, cwd = WS) {
  const verdict = classifyProposedCommand(command, { workspaceRoot: cwd, level: 'L2' });
  if (verdict.decision === 'allow') return { ok: true as const, kind: 'gate-allow' };
  if (verdict.decision !== 'gray') return { ok: false as const, reason: `gate:${verdict.decision}` };
  const request = { command, signals: verdict.signals, reason: verdict.reason, cwd, workspaceRoot: cwd };
  return escalationAutoApprovable(request, { ...allOpts, ...opts });
}

/** The same request filed straight to this module as a gray boundary
 *  escalation with the soft signals only — refusals must come from the
 *  "all"-level checks themselves, whatever the gate would have added (the
 *  gate allows some of these outright at L2; that is the gate's call). */
function direct(command: string, opts: Partial<EscalationAutoApproveOpts> = {}, cwd = WS) {
  const request = { command, signals: ['leaves-root', 'write-or-exec'], reason: 'boundary: leaves-root, write-or-exec', cwd, workspaceRoot: cwd };
  return escalationAutoApprovable(request, { ...allOpts, ...opts });
}

/** Answered with the gate's real verdict AND by the "all" checks alone. */
function expectAnswered(command: string, cwd = WS) {
  expect([command, judge(command, {}, cwd)]).toEqual([command, ANSWERED]);
  expect([command, direct(command, {}, cwd)]).toEqual([command, ANSWERED]);
}
const ALL_OK = { ok: true, kind: 'all' };

/** Both spellings a worker produces: Claude's raw Bash command and Codex's
 *  shlex-joined `bash -lc '<script>'`. */
const spellings = (script: string) => [script, `bash -lc ${sq(script)}`];

describe('the four build-2790 asks', () => {
  const C1 = 'cd ~/demo && git status --short && git log --oneline -3; grep -c "Neon Breaker\\|NEON BREAKER" claude.html; tail -c 200 claude.html';
  const C2 = 'cp ~/demo/claude.html /tmp/claude.html.bak && echo ok';
  const C3 = "sed -n '/<script>/,/<\\/script>/p' claude.html | sed '1d;$d' > $TMPDIR/cb.js && node --check $TMPDIR/cb.js && echo OK";
  const C4 = 'node -e \'const fs=require("fs");const s=fs.readFileSync("claude.html","utf8");const m=s.match(/<script>([\\s\\S]*?)<\\/script>/);new Function(m[1]);console.log("ok")\'';

  it('1: a quoted \\| is not a pipe — the read-only git / grep / tail chain auto-approves', () => {
    for (const command of spellings(C1)) {
      expect([command, judge(command)]).toEqual([command, ALL_OK]);
      // Also when the run's cwd is another project and ~/demo is the workspace.
      expect([command, judge(command, {}, CS)]).toEqual([command, ALL_OK]);
    }
  });

  it('2: a copy into /tmp auto-approves', () => {
    for (const command of spellings(C2)) {
      expect([command, judge(command)]).toEqual([command, ALL_OK]);
    }
  });

  it('3: sed | sed > $TMPDIR/cb.js && node --check $TMPDIR/cb.js auto-approves', () => {
    for (const command of spellings(C3)) {
      expect([command, judge(command)]).toEqual([command, ALL_OK]);
    }
    expect(judge(C3.replace(/\$TMPDIR/g, '${TMPDIR}'))).toEqual(ALL_OK);
    expect(judge(C3.replace(/\$TMPDIR/g, '"$TMPDIR"'))).toEqual(ALL_OK);
  });

  it('4: node -e still asks (arbitrary code)', () => {
    for (const command of spellings(C4)) {
      expect([command, direct(command).ok]).toEqual([command, false]);
    }
  });

  it('the standard level is unchanged: none of the four is answered there', () => {
    for (const command of [C1, C2, C3, C4]) {
      const v = judge(command, { level: 'standard' });
      // Each one reached a human on device: a gray gate verdict the standard rules refuse.
      expect([command, v.ok, v.ok === false && v.reason.startsWith('gate:')]).toEqual([command, false, false]);
    }
  });

  it('unattended runs fall back to the standard rules', () => {
    for (const command of [C2, C3]) expect(judge(command, { attended: false }).ok).toBe(false);
  });
});

describe('quote-aware splitting', () => {
  it('quoted | ; && are words; real ones split', () => {
    const lex = lexAllLevelScript('grep "a|b;c&&d" f | wc -l');
    expect(lex.ok).toBe(true);
    if (lex.ok) {
      expect(lex.segments.map((s) => s.words.map((w) => w.text))).toEqual([['grep', 'a|b;c&&d', 'f'], ['wc', '-l']]);
      expect(lex.segments.map((s) => s.piped)).toEqual([true, true]);
    }
    expectAnswered("grep 'a|b' claude.html && grep \"x;y\" claude.html");
  });

  it('a quoted pipe is fine, a real pipe into a shell / interpreter asks', () => {
    expectAnswered('grep "a|sh" claude.html');
    for (const command of [
      'grep "x" claude.html | sh',
      'grep x claude.html | bash -c "rm -rf ~/bin"',
      "echo 'rm -rf ~/bin' | bash",
      'cat claude.html | node',
      'grep "a\\|b" claude.html|sh',
    ]) {
      expect([command, direct(command).ok]).toEqual([command, false]);
    }
  });

  it('a quoted "<<EOF" is not a heredoc: the lines after it are commands', () => {
    for (const script of [
      'cat > ~/demo/a.txt "<<EOF"\ncp evil ~/bin/git\nEOF',
      "cat > ~/demo/a.txt '<<'EOF\ncp evil ~/bin/git\nEOF",
      'cat > ~/demo/a.txt \\<<EOF\ncp evil ~/bin/git\nEOF',
    ]) {
      for (const command of spellings(script)) expect([command, direct(command).ok]).toEqual([command, false]);
    }
    // A real quoted heredoc into the workspace still writes.
    expectAnswered(`bash -lc ${sq("cat > ~/demo/a.txt <<'EOF'\ncp evil ~/bin/git\nEOF")}`);
  });

  it('a # comment cannot open a quote that hides the next line', () => {
    for (const command of spellings('ls # "\ncp evil ~/bin/git\n# "')) {
      expect([command, direct(command).ok]).toEqual([command, false]);
    }
    expectAnswered('ls # a comment with "quotes" and | pipes');
  });

  it('a backslash-joined terminator ends the heredoc where bash ends it', () => {
    const command = `bash -lc ${sq('cat > ~/demo/a.txt <<EOF\nhello\nE\\\nOF\ncp evil ~/bin/git')}`;
    expect(direct(command).ok).toBe(false);
  });

  it('unbalanced quotes ask', () => {
    expect(lexAllLevelScript('cat "a').ok).toBe(false);
    expect(lexAllLevelScript("cat 'a").ok).toBe(false);
  });

  it('a quoted word holding < or > is still a path (no more skip)', () => {
    for (const command of [
      'cp evil "x>y/../../bin/git"',
      'cp evil "$HOME/bin/>x/../git"',
      'cp evil "/sdcard/Download/a>b"',
      'cp evil ~/bin/"a<b"',
    ]) {
      expect([command, direct(command).ok]).toEqual([command, false]);
    }
    // Markup in a sed / grep pattern and in echo text stays data.
    expectAnswered("grep -c '</div>' claude.html && echo '<p>a/b</p>' > ~/demo/n.html");
  });
});

describe('$TMPDIR and /tmp', () => {
  it('copies, writes and syntax checks in scratch dirs are allowed', () => {
    for (const command of [
      'cp claude.html $TMPDIR/claude.html.bak',
      'cp claude.html "${TMPDIR}/x.html" && ls -la $TMPDIR',
      'mkdir -p $TMPDIR/work && cp claude.html $TMPDIR/work/',
      "cat > $TMPDIR/a.js <<'EOF'\nconst a = `${b}`;\nEOF",
      'node --check /tmp/cb.js',
      'bash -n $TMPDIR/x.sh',
      'rm -f /tmp/claude.html.bak $TMPDIR/cb.js',
      `cp claude.html ${HOME}/tmp/a.html`,
    ]) {
      expectAnswered(command);
    }
  });

  it('/tmp/../ and $TMPDIR/../ do not escape', () => {
    for (const [command, reason] of [
      ['cp claude.html /tmp/../data/local/x', 'outside-home'],
      ['cp claude.html /tmp/x/../../sdcard/Download/x', 'outside-home'],
      ['cp claude.html $TMPDIR/../bin/git', 'unresolved-path'],
      ['cp claude.html ${TMPDIR}/../.bashrc', 'unresolved-path'],
      ['cp claude.html /tmp/../../data/user/0/dev.shelly.terminal/files/home/bin/git', 'shelly-control-path'],
    ] as const) {
      expect([command, direct(command)]).toEqual([command, { ok: false, reason }]);
    }
  });

  it('only $TMPDIR / ${TMPDIR} / $HOME / ${HOME} at the start of a word expand', () => {
    for (const command of [
      'cp claude.html ${TMPDIR:-/}/x',
      'cp claude.html $TMPDIRX/y',
      'cp claude.html "$TMPDIR"x',
      'cp claude.html x$TMPDIR',
      'cp claude.html $TMPDIR/$(id)',
      'cp claude.html "$TMPDIR/`id`"',
      'cp claude.html $TMPDIR/$USER',
      'cp $TMPDIR/a $HOME/bin/git',
      "cp claude.html $'\\x2fsdcard'",
    ]) {
      expect([command, direct(command).ok]).toEqual([command, false]);
    }
    expectAnswered('cp $TMPDIR/a.html $HOME/demo/b.html');
  });

  it('secrets never go to a scratch dir', () => {
    for (const command of [
      'cp ~/.ssh/id_rsa /tmp/k',
      'cp ~/demo/.env $TMPDIR/e',
      'cat ~/.codex/auth.json > $TMPDIR/a',
      'cp ~/.claude-token.env /tmp/t',
      'cp ~/.shelly/agents/x.json $TMPDIR/x',
      'cp ~/demo/server.pem $TMPDIR/',
    ]) {
      expect([command, direct(command).ok]).toEqual([command, false]);
    }
  });

  it('a file written to a scratch dir is never run', () => {
    for (const command of [
      "echo 'rm -rf ~' > $TMPDIR/x.sh && bash $TMPDIR/x.sh",
      'cp a.sh /tmp/x && chmod +x /tmp/x && /tmp/x',
      'cp a.sh $TMPDIR/x && $TMPDIR/x',
      'cp a.sh $TMPDIR/x && . $TMPDIR/x',
      'cp a.sh $TMPDIR/x && source $TMPDIR/x',
      'cp a.js $TMPDIR/x.js && node $TMPDIR/x.js',
      'sh $TMPDIR/x.sh',
    ]) {
      expect([command, direct(command).ok]).toEqual([command, false]);
    }
  });

  it('runtime files, dot files and the scratch root itself are not touched', () => {
    for (const [command, reason] of [
      ['rm -f $TMPDIR/shelly-claude-proxy.123.port', 'shelly-control-path'],
      ['touch /tmp/shelly-codex-remote.stopped', 'shelly-control-path'],
      ['rm -rf $TMPDIR/codex-rc-1', 'shelly-control-path'],
      ['cp a $TMPDIR/.x', 'protected-path'],
      ['rm -f $TMPDIR/*', 'unresolved-path'],
      ['cp a /tmp', 'temp-root'],
      ['cd $TMPDIR && rm -f *', 'unresolved-path'],
      ['cd $TMPDIR && rm -f shelly-claude-proxy.1.port', 'shelly-control-path'],
    ] as const) {
      const v = direct(command);
      expect([command, v.ok]).toEqual([command, false]);
      if (v.ok === false && !v.reason.startsWith('gate:')) expect([command, v.reason]).toEqual([command, reason]);
    }
  });

  it('symlinks into scratch dirs: relative targets and cp -s ask', () => {
    for (const [command, reason] of [
      ['ln -s ../bin $TMPDIR/b', 'option:ln'],
      ['ln -sf ../../bin/git $TMPDIR/g', 'option:ln'],
      ['ln -st $TMPDIR ../bin', 'option:ln'],
      ['cp -s claude.html $TMPDIR/l', 'option:cp'],
    ] as const) {
      expect([command, direct(command)]).toEqual([command, { ok: false, reason }]);
    }
    expect(judge(`ln -s ${HOME}/bin $TMPDIR/b`)).toEqual({ ok: false, reason: 'shelly-control-path' });
    expectAnswered('ln -s ~/demo/claude.html $TMPDIR/l');
  });

  it('other paths outside the home still ask', () => {
    expect(judge('cp claude.html /sdcard/Download/a.html')).toEqual({ ok: false, reason: 'outside-home' });
    expect(judge('cp claude.html /data/local/tmp/a.html')).toEqual({ ok: false, reason: 'outside-home' });
    expect(judge('cp claude.html /tmpx/a.html')).toEqual({ ok: false, reason: 'outside-home' });
  });
});

describe('read-only git / file tools at "all"', () => {
  it('local read git subcommands and grep / tail / head / wc / cat / ls are answered', () => {
    for (const command of [
      'cd ~/demo && git status --short && git diff --stat && git show HEAD --stat',
      'git -C ~/demo log --oneline -5',
      'head -n 20 claude.html; wc -l claude.html; cat claude.html | grep -c canvas; ls -la ~/demo',
      'grep -rn "requestAnimationFrame" ~/demo',
    ]) {
      expectAnswered(command, CS);
    }
  });

  it('network git still asks', () => {
    for (const command of [
      'cd ~/demo && git status && git push',
      'cd ~/demo && git fetch origin',
      'git -C ~/demo pull',
      'cd ~ && git clone https://github.com/x/y',
      'git remote add o https://x',
    ]) {
      expect([command, direct(command, {}, CS).ok]).toEqual([command, false]);
    }
  });
});

describe('cwd tracking holes', () => {
  it('a cd that may fail or be skipped keeps the old cwd possible', () => {
    for (const command of [
      'cd ~ && cd ~/nonexistent; rm -rf bin',
      'cd ~ || cd ~/demo && rm -rf bin',
      'cd ~ && ! cd ~/nope && rm -rf bin',
      'cd ~ && (cd ~/demo) && rm -rf bin',
      'cd ~ && cd ~/demo | true && rm -rf bin',
      'cd ~ && cd ~/demo & rm -rf bin',
    ]) {
      expect([command, direct(command).ok]).toEqual([command, false]);
    }
    // A plain && chain still narrows.
    expectAnswered('cd ~ && cd ~/demo && rm -f old.html');
  });

  it('options with an attached path are checked', () => {
    for (const command of [
      'sort -o/sdcard/Download/x claude.html',
      'cp -t/sdcard/Download claude.html',
      'cp -t~/bin claude.html',
    ]) {
      expect([command, direct(command).ok]).toEqual([command, false]);
    }
  });

  it('sed commands that run or write ask wherever they appear', () => {
    for (const command of [
      "sed '1e touch x' claude.html",
      "sed -n '$w /sdcard/x' claude.html",
      "sed -n '/a/,/b/W out' claude.html",
      "sed -i 's/a/b/ge' claude.html",
      "sed --expression='1e id' claude.html",
      "sed -e1e claude.html",
    ]) {
      expect([command, direct(command).ok]).toEqual([command, false]);
    }
    expectAnswered("sed -i 's/score/points/g' claude.html");
  });
});

describe('more lexer / path adversarial cases', () => {
  it('a wrapper with words after its script word is judged as written', () => {
    expect(direct("bash -lc 'echo hi' \"'\" ; cp evil ~/bin/git ; \"'\"").ok).toBe(false);
  });

  it('redirect spellings all have their target checked', () => {
    for (const command of [
      "cat <<'EOF' > ~/bin/git\nx\nEOF",
      'echo x >| ~/bin/git',
      'echo x 1>~/bin/git',
      'echo x &>~/bin/git',
      'echo x >>$TMPDIR/shelly-codex-remote.host',
      'cat <<< "x" > ~/bin/git',
    ]) {
      expect([command, direct(command).ok]).toEqual([command, false]);
    }
    expectAnswered('echo x > $TMPDIR/note.txt 2>&1');
  });

  it('brace lists and dot globs that the `..` normalization cannot follow ask', () => {
    for (const command of [
      'cp evil ~/demo/sub/{x,../../bin}/git',
      'cp evil /tmp/a/b/{c,../../../../sdcard/x}/y',
      'cp evil ~/demo/.*/bin/git',
      'cp evil ~/demo/{1..3}/../../bin/git',
    ]) {
      expect([command, direct(command).ok]).toEqual([command, false]);
    }
  });

  it('$( and backticks anywhere outside single quotes ask; inside single quotes they are text', () => {
    expect(direct('cp claude.html "$(echo ~/bin/git)"').ok).toBe(false);
    expect(direct('cp claude.html `echo ~/bin/git`').ok).toBe(false);
    // (The gate itself still files this as indirect-exec — its own call.)
    expect(direct("grep -c '$(not run)' claude.html")).toEqual(ANSWERED);
  });
});

describe('worker prompt hint (driver)', () => {
  it('both engines get the syntax-check hint; driver and APK asset stay identical', () => {
    const driver = fs.readFileSync(path.join(ROOT, 'scripts/shelly-agent-driver.js'), 'utf8');
    const asset = fs.readFileSync(path.join(ROOT, 'modules/terminal-emulator/android/src/main/assets/shelly-agent-driver.js'), 'utf8');
    expect(asset).toBe(driver);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { workerPrompt, WORKER_PROMPT_HINT } = require(path.join(ROOT, 'scripts/shelly-agent-driver.js'));
    expect(WORKER_PROMPT_HINT).toMatch(/node --check/);
    expect(WORKER_PROMPT_HINT).toMatch(/node -e/);
    expect(WORKER_PROMPT_HINT).toMatch(/\$TMPDIR/);
    expect(workerPrompt('build a game')).toBe(`build a game\n\n${WORKER_PROMPT_HINT}`);
    expect(driver).toMatch(/text: workerPrompt\(config\.prompt\), text_elements/);
    expect(driver).toMatch(/content: \[\{ type: 'text', text: workerPrompt\(config\.prompt\) \}\]/);
  });
});

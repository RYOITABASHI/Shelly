/**
 * "承認なしで実行（すべて）" — quote-aware lexing, scratch dirs and $TMPDIR
 * (2026-11-02, on-device build 2790: a Claude Code worker in an attended
 * "all"-level run still asked for four routine commands).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  allLevelLinkProbe,
  autoApprovalLinkProbe,
  escalationAutoApprovable,
  lexAllLevelScript,
  linkProbeIsClean,
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
      ['cp claude.html /tmp/../data/local/x', 'parent-path'],
      ['cp claude.html /tmp/x/../../sdcard/Download/x', 'parent-path'],
      ['cp claude.html $TMPDIR/../bin/git', 'parent-path'],
      ['cp claude.html ${TMPDIR}/../.bashrc', 'parent-path'],
      ['cp claude.html /tmp/../../data/user/0/dev.shelly.terminal/files/home/bin/git', 'parent-path'],
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
      ['rm -f /tmp/codex-daemon-10345/abc', 'shelly-control-path'],
      ['cp a.txt /tmp/codex-daemon-10345/abc', 'shelly-control-path'],
      ['mv a.txt /tmp/codex-daemon-10345/abc', 'shelly-control-path'],
      ['tee /tmp/codex-daemon-10345/abc', 'shelly-control-path'],
      ['mkdir -p /tmp/codex-daemon-10345', 'shelly-control-path'],
      ['rm -f $TMPDIR/codex-daemon-1/x', 'shelly-control-path'],
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

  it('no command that can create a link is answered (review 2026-11-02)', () => {
    for (const command of [
      'ln -s /sdcard $TMPDIR/l && echo x > $TMPDIR/l/a',
      'ln -s ../bin $TMPDIR/b',
      'ln -s ~/demo/claude.html $TMPDIR/l',
      'ln ~/demo/claude.html ~/demo/hard',
      'ln -t $TMPDIR ~/demo/a',
      'ln --symbolic /sdcard ~/demo/l',
      'cp -s claude.html $TMPDIR/l',
      'cp -l claude.html $TMPDIR/l',
      'cp --symbolic-link claude.html $TMPDIR/l',
      'cp --link claude.html $TMPDIR/l',
      'cp -a ~/demo $TMPDIR/d',
      'cp -rP ~/demo $TMPDIR/d',
      'cp -d ~/demo/l $TMPDIR/l',
      'cp --archive ~/demo $TMPDIR/d',
      'cp --no-dereference ~/demo/l $TMPDIR/l',
      'cp --preserve=links -r ~/demo $TMPDIR/d',
      'cp --preserve=all ~/demo/a $TMPDIR/a',
      'git apply x.patch',
      'patch -p1 < x.patch',
      'cd ~/demo && touch a; ln -sf /sdcard/Download b',
    ]) {
      expect([command, direct(command)]).toEqual([command, { ok: false, reason: 'link-create' }]);
    }
    // Plain copies still go through.
    expectAnswered('cp -r ~/demo/assets $TMPDIR/assets');
    expectAnswered('cp -p claude.html $TMPDIR/c.html');
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

describe('environment that turns a check into code execution', () => {
  it('assigning / exporting / unsetting the sensitive variables asks', () => {
    for (const command of [
      'NODE_OPTIONS=--require=./x.js node --check a.js',
      'BASH_ENV=./x.sh bash -n a.sh',
      'ENV=./x.sh sh -n a.sh',
      'CDPATH=/sdcard cd demo && rm -f a',
      'PATH=. ls',
      'HOME=/sdcard cp a ~/b',
      'TMPDIR=/sdcard cp a $TMPDIR/b',
      'export NODE_OPTIONS=--require=./x.js; node --check a.js',
      'export BASH_ENV=x',
      'declare -x BASH_ENV=x',
      'typeset -x ENV=x',
      'unset HOME; ls',
      'env NODE_OPTIONS=-r./x node --check a.js',
      'NODE_OPTIONS+=" -r ./x"; node --check a.js',
      'cd ~/demo && PROMPT_COMMAND=x ls',
    ]) {
      expect([command, direct(command).ok]).toEqual([command, false]);
    }
    expect(direct('NODE_OPTIONS=--require=./x.js node --check a.js')).toEqual({ ok: false, reason: 'env-change' });
    expect(direct('export BASH_ENV=x')).toEqual({ ok: false, reason: 'env-change' });
    // The syntax checks themselves stay answered (the driver strips the
    // variables from the worker env — next describe).
    expectAnswered('node --check game.js && bash -n build.sh');
  });

  it('the driver strips them from every child it starts (Codex, Claude runner, gate)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const driver = require(path.join(ROOT, 'scripts/shelly-agent-driver.js'));
    const dirty = {
      HOME: '/h', PATH: '/bin', TMPDIR: '/h/tmp', NODE_PATH: '/h/lib/node_modules',
      NODE_OPTIONS: '--require=/h/x.js', BASH_ENV: '/h/x.sh', ENV: '/h/x.sh', CDPATH: '/sdcard', PROMPT_COMMAND: 'id',
    };
    expect(driver.WORKER_ENV_DROP).toEqual(expect.arrayContaining(['NODE_OPTIONS', 'BASH_ENV', 'ENV', 'CDPATH', 'PROMPT_COMMAND']));
    const envs = [
      driver.sanitizeWorkerEnv(dirty),
      driver.codexChildEnv(dirty),
      driver.claudeChildEnv(dirty, { source: 'subscription' }),
      driver.claudeChildEnv({ ...dirty, ANTHROPIC_API_KEY: 'k' }, { source: 'api-key' }),
    ];
    const saved = { ...process.env };
    try {
      Object.assign(process.env, dirty);
      envs.push(driver.codexAppServerSpawnSpec({ codexBin: 'codex' }).env);
      envs.push(driver.gateSpawnSpec({ nodeBin: 'node', gateScript: 'gate.js' }).env);
      envs.push(driver.claudeRunnerSpawnSpec({ claudeRunner: 'run.sh', claudeRunnerInterpreter: 'bash' }, { source: 'subscription' }).env);
    } finally {
      for (const k of Object.keys(dirty)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    for (const env of envs) {
      for (const key of ['NODE_OPTIONS', 'BASH_ENV', 'ENV', 'CDPATH', 'PROMPT_COMMAND']) expect([key, env[key]]).toEqual([key, undefined]);
      expect(env.HOME).toBe('/h');
      expect(env.NODE_PATH).toBe('/h/lib/node_modules'); // kept: module lookup only
    }
    // The generated Claude Bash-tool env file unsets them before its bash re-exec.
    const homeKt = fs.readFileSync(path.join(ROOT, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt'), 'utf8');
    expect(homeKt).toContain('sb.appendLine("unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN NODE_OPTIONS BASH_ENV ENV CDPATH PROMPT_COMMAND")');
  });
});

describe('link probe for existing symlinks (review 2026-11-02)', () => {
  const probeOf = (command: string, cwd = WS) => allLevelLinkProbe(
    { command, signals: ['leaves-root', 'write-or-exec'], reason: 'boundary: leaves-root, write-or-exec', cwd, workspaceRoot: cwd },
    allOpts,
  );

  it('tests every component below its allowed root, the cwd and bare words', () => {
    const p = probeOf('echo x > out && cp claude.html $TMPDIR/sub/c.html');
    expect(p.ok).toBe(true);
    if (p.ok) {
      for (const comp of [WS, `${WS}/out`, `${WS}/claude.html`, `${HOME}/tmp/sub`, `${HOME}/tmp/sub/c.html`]) {
        expect([comp, p.command.includes(`'${comp}'`)]).toEqual([comp, true]);
      }
      // ~/tmp itself is probed; the home never is (/data/user/0 is itself a
      // link on Android).
      expect(p.command).toContain(`'${HOME}/tmp'`);
      expect(p.command).not.toContain(`'${HOME}'`);
      expect(p.command).toMatch(/\[ -L "\$p" \] && echo "LINK \$p"/);
      expect(p.command.trim().split('\n').pop()).toBe('echo SHELLY_LINK_PROBE_DONE');
    }
  });

  it('globs: the directory is listed; a glob before the last component asks', () => {
    const p = probeOf('rm -f ~/notes/*.tmp');
    expect(p.ok && p.command.includes(`'${HOME}/notes'/* '${HOME}/notes'/.[!.]*`)).toBe(true);
    expect(probeOf('cp a ~/demo/d*/x')).toEqual({ ok: false, reason: 'link-probe-glob' });
  });

  it('recursive copies and moves have their sources searched for links', () => {
    const p = probeOf('cp -r ~/demo/assets $TMPDIR/assets && mv ~/demo/old ~/demo/new');
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.command).toContain(`__o=$(LD_LIBRARY_PATH= /system/bin/find '${WS}/assets' -type l 2>&1); __rc=$?; if [ "$__rc" -ne 0 ]; then echo "LINK ?"; elif [ -n "$__o" ]; then echo "LINK $__o"; fi`);
      expect(p.command).toContain(`/system/bin/find '${WS}/old' -type l`);
      expect(p.command).toContain(`if [ -e '${WS}/old' ] || [ -L '${WS}/old' ]; then`);
    }
  });

  it('paths are single-quoted safely', () => {
    const p = probeOf("cp claude.html \"$TMPDIR/it's\"");
    expect(p.ok && p.command.includes(`'${HOME}/tmp/it'\\''s'`)).toBe(true);
  });

  it('a refused command has no probe', () => {
    expect(probeOf('ln -s /sdcard $TMPDIR/l')).toEqual({ ok: false, reason: 'link-create' });
  });

  it('the probe really finds a link (POSIX sh, real filesystem)', () => {
    if (process.platform === 'win32') return; // NTFS symlinks need privileges
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawnSync } = require('child_process');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('os');
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rwa-probe-')));
    try {
      fs.mkdirSync(path.join(home, 'demo'));
      fs.mkdirSync(path.join(home, 'tmp'));
      const opts = { ...allOpts, homePaths: [home], trustedWorkspaceRoot: `${home}/demo` };
      const probe = (command: string) => {
        const p = allLevelLinkProbe({ command, signals: ['leaves-root', 'write-or-exec'], reason: 'boundary: leaves-root', cwd: `${home}/demo`, workspaceRoot: `${home}/demo` }, opts);
        if (p.ok === false) throw new Error(p.reason);
        const r = spawnSync('/bin/sh', ['-c', p.command], { encoding: 'utf8' });
        return linkProbeIsClean({ exitCode: r.status ?? 1, stdout: r.stdout ?? '' });
      };
      expect(probe('echo x > out && cp a $TMPDIR/b')).toBe(true);
      fs.symlinkSync(os.tmpdir(), path.join(home, 'demo', 'out'));
      expect(probe('echo x > out')).toBe(false);
      expect(probe('cp a $TMPDIR/b')).toBe(true);
      fs.mkdirSync(path.join(home, 'demo', 'assets'));
      fs.symlinkSync('/etc', path.join(home, 'demo', 'assets', 'l'));
      expect(probe('cp -r assets $TMPDIR/assets')).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('linkProbeIsClean: only a probe that ran to the end and printed no LINK', () => {
    expect(linkProbeIsClean({ exitCode: 0, stdout: 'SHELLY_LINK_PROBE_DONE\n' })).toBe(true);
    expect(linkProbeIsClean({ exitCode: 0, stdout: `LINK ${WS}/out\nSHELLY_LINK_PROBE_DONE\n` })).toBe(false);
    expect(linkProbeIsClean({ exitCode: 0, stdout: '' })).toBe(false);
    expect(linkProbeIsClean({ exitCode: 1, stdout: 'SHELLY_LINK_PROBE_DONE\n' })).toBe(false);
    expect(linkProbeIsClean({ exitCode: 0, stdout: 'SHELLY_LINK_PROBE_DONE\nmore' })).toBe(false);
    expect(linkProbeIsClean(null)).toBe(false);
  });

  it('_layout runs the probe before signing an "all" auto-approval', () => {
    const layout = fs.readFileSync(path.join(ROOT, 'app/_layout.tsx'), 'utf8');
    const probeAt = layout.indexOf('autoApprovalLinkProbe(minted, mintedOpts)');
    const cleanAt = layout.indexOf('linkProbeIsClean(probeResult)');
    const signAt = layout.indexOf('TerminalEmulator.resolveAgentEscalationAutoApproval(minted.runId');
    expect(probeAt).toBeGreaterThan(0);
    expect(cleanAt).toBeGreaterThan(probeAt);
    expect(signAt).toBeGreaterThan(cleanAt);
  });
});

describe('second review (2026-11-02): .., globbed tree sources, find fail-open, standard-level writes', () => {
  const stdReq = (command: string) => ({ command, signals: ['write-or-exec'], reason: 'boundary: write-or-exec', cwd: WS, workspaceRoot: WS });
  const stdOpts: EscalationAutoApproveOpts = { ...allOpts, level: 'standard' };

  it('A: no path with a `..` component is answered (the kernel follows it through links)', () => {
    for (const command of [
      'echo x > ~/demo/l/../y',
      'echo x > l/../y',
      'cp claude.html ~/demo/l/../y',
      'cd ~/demo/l/.. && rm -f y',
      'node --check l/../a.js',
      "cat > l/../a.txt <<'EOF'\nx\nEOF",
      'rm -f $TMPDIR/l/../x',
      'sort -o../x claude.html',
    ]) {
      expect([command, direct(command).ok]).toEqual([command, false]);
      expect([command, escalationAutoApprovable(stdReq(command), stdOpts).ok]).toEqual([command, false]);
    }
    expect(direct('echo x > ~/demo/l/../y')).toEqual({ ok: false, reason: 'parent-path' });
    // A pure read through `..` stays a read (nothing is written through a link).
    expect(direct('cd .. && ls')).toEqual({ ok: true, kind: 'read' });
  });

  it('B: a globbed recursive cp / mv source asks (the probe cannot see what it expands to)', () => {
    for (const command of ['cp -r ~/demo/* $TMPDIR/out', 'mv ~/demo/*.html $TMPDIR/out/', 'cp -R assets/* $TMPDIR/a']) {
      expect([command, direct(command).ok]).toEqual([command, true]); // the lexical verdict alone …
      expect([command, autoApprovalLinkProbe(stdReq(command), allOpts)]).toEqual([command, { ok: false, reason: 'link-probe-glob' }]);
    }
  });

  it('C: a find that cannot run (missing /system/bin/find, denied, failing) reads as a link', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawnSync } = require('child_process');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('os');
    const sh = process.platform === 'win32' ? 'C:/Program Files/Git/bin/sh.exe' : '/bin/sh';
    if (!fs.existsSync(sh) || fs.existsSync('/system/bin/find')) return;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rwa-find-')).replace(/\\/g, '/');
    const shHome = process.platform === 'win32' ? home.replace(/^([A-Za-z]):/, (_m: string, d: string) => `/${d.toLowerCase()}`) : home;
    try {
      fs.mkdirSync(path.join(home, 'demo', 'assets'), { recursive: true });
      const opts = { ...allOpts, homePaths: [shHome], trustedWorkspaceRoot: `${shHome}/demo` };
      const p = allLevelLinkProbe({ command: 'cp -r assets $TMPDIR/assets', signals: ['leaves-root', 'write-or-exec'], reason: 'boundary: x', cwd: `${shHome}/demo`, workspaceRoot: `${shHome}/demo` }, opts);
      expect(p.ok).toBe(true);
      if (p.ok === false) return;
      const r = spawnSync(sh, ['-c', p.command], { encoding: 'utf8' });
      expect(r.stdout).toContain('LINK ?');
      expect(linkProbeIsClean({ exitCode: r.status ?? 1, stdout: r.stdout ?? '' })).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('D: standard-level in-root writes are probed too; reads are not', () => {
    const w = autoApprovalLinkProbe(stdReq('echo x > out/a.txt'), stdOpts);
    expect(escalationAutoApprovable(stdReq('echo x > out/a.txt'), stdOpts)).toEqual({ ok: true, kind: 'in-root-write' });
    expect(w && w.ok && w.command.includes(`'${WS}/out'`) && w.command.includes(`'${WS}/out/a.txt'`)).toBe(true);
    const r = { command: 'cat claude.html', signals: ['leaves-root'], reason: 'boundary: leaves-root', cwd: WS, workspaceRoot: WS };
    expect(escalationAutoApprovable(r, stdOpts)).toEqual({ ok: true, kind: 'read' });
    expect(autoApprovalLinkProbe(r, stdOpts)).toBeNull();
    const m = autoApprovalLinkProbe(stdReq('mv old new'), stdOpts);
    expect(m && m.ok && m.command.includes(`/system/bin/find '${WS}/old'`)).toBe(true);
  });

  it('D: link-creating commands are never answered, at either level', () => {
    for (const command of [
      'ln -s x l',
      'ln -s /sdcard/Download l',
      'patch -p1 < x.patch',
      'git checkout HEAD~1 -- l',
      'git checkout -- l && echo x > l/a',
      'git restore l',
      'git switch other',
      'git stash pop',
      'git apply x.patch',
      'git am x.mbox',
      'git merge other',
      'git reset --hard HEAD~1',
      'git cherry-pick abc',
      'git rebase main',
      'git revert abc',
      'cp -a src dst',
      'cp -s a b',
    ]) {
      const std = escalationAutoApprovable(stdReq(command), stdOpts);
      // (`git reset --hard` is already command-safety HIGH at the standard level.)
      expect([command, std.ok === false && (std.reason === 'link-create' || std.reason === 'safety:HIGH')]).toEqual([command, true]);
      expect([command, direct(command)]).toEqual([command, { ok: false, reason: 'link-create' }]);
    }
    // Plain in-root writes keep working at the standard level.
    expect(escalationAutoApprovable(stdReq('git add a.txt && git commit -m x'), stdOpts)).toEqual({ ok: true, kind: 'in-root-write' });
  });

  it('_layout probes every non-read auto-approval, not only the "all" level', () => {
    const layout = fs.readFileSync(path.join(ROOT, 'app/_layout.tsx'), 'utf8');
    expect(layout).toContain("const probe = verdict.kind === 'read' ? null : autoApprovalLinkProbe(minted, mintedOpts);");
    expect(layout).not.toContain("if (verdict.kind === 'all') {");
  });
});

describe('worker prompt hint (driver)', () => {
  it('both engines get the syntax-check hint; driver and APK asset stay identical', () => {
    const driver = fs.readFileSync(path.join(ROOT, 'scripts/shelly-agent-driver.js'), 'utf8');
    const asset = fs.readFileSync(path.join(ROOT, 'modules/terminal-emulator/android/src/main/assets/shelly-agent-driver.js'), 'utf8');
    expect(asset).toBe(driver);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { turnPrompt, workerPrompt, WORKER_PROMPT_HINT } = require(path.join(ROOT, 'scripts/shelly-agent-driver.js'));
    expect(WORKER_PROMPT_HINT).toMatch(/node --check/);
    expect(WORKER_PROMPT_HINT).toMatch(/node -e/);
    expect(WORKER_PROMPT_HINT).toMatch(/\$TMPDIR/);
    expect(workerPrompt('build a game')).toBe(`build a game\n\n${WORKER_PROMPT_HINT}`);
    expect(turnPrompt({ prompt: 'build a game' })).toBe(workerPrompt('build a game'));
    expect(driver).toMatch(/text: turnPrompt\(config\), text_elements/);
    expect(driver).toMatch(/content: \[\{ type: 'text', text: turnPrompt\(config\) \}\]/);
  });
});

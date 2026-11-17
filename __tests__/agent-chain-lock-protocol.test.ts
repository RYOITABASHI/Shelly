/**
 * Gate fix round 2 (re-gate R2): the ONE chain-lock protocol
 * (lib/agent-chain-lock-protocol.ts == APK asset shelly-chain-lock.sh), run
 * for real on a real filesystem under bash (the JS runCommand shell) and dash
 * (a strict POSIX sh, standing in for Android's /system/bin/sh, which
 * AgentRuntime uses). Interleavings are injected through the protocol's
 * no-op hook `shelly_cl_hook <point>`, redefined after the library.
 *
 * Invariants pinned here:
 *  - cleanup never removes, moves or strands a lock instance it did not
 *    validate: a fresh lock B that replaced a validated-stale lock A mid-
 *    cleanup survives intact at the canonical path, and cleanup reports
 *    LOCKED (the re-gate interleaving, in each window of the cleanup);
 *  - a just-created lock whose metadata is not written yet is never deleted;
 *  - the stale policy is still acquired-at >= CHAIN_LOCK_STALE_MS (plus the
 *    directory-age guard), and exactly one of many concurrent acquirers wins.
 */
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CHAIN_LOCK_SHELL } from '@/lib/agent-chain-lock-protocol';
import { CHAIN_LOCK_STALE_MS } from '@/lib/agent-schedule-reconcile';

const ROOT = path.resolve(__dirname, '..');
const ASSET = path.join(ROOT, 'modules/terminal-emulator/android/src/main/assets/shelly-chain-lock.sh');
const KT = path.join(ROOT, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/');
const STALE = Math.floor(CHAIN_LOCK_STALE_MS / 1000);
const nowSec = (): number => Math.floor(Date.now() / 1000);
const OLD = (): number => nowSec() - 3 * 3600;

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

let work: string;
let lib: string;
beforeAll(() => {
  work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'chain-lock-protocol-'));
  lib = path.join(work, 'lib.sh');
  fs.writeFileSync(lib, CHAIN_LOCK_SHELL);
});
afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

describe('one protocol, shared byte for byte', () => {
  it('the APK asset equals CHAIN_LOCK_SHELL', () => {
    expect(fs.readFileSync(ASSET, 'utf8')).toBe(CHAIN_LOCK_SHELL);
  });
  it('the library itself never contains a JS command marker (tests route runCommand mocks by them)', () => {
    expect(CHAIN_LOCK_SHELL).not.toMatch(/# CHAIN_LOCK_|CHAIN_LOCK_(ACQUIRE|RELEASE|CHECK|DISARM)/);
  });
  it('native runs the asset through /system/bin/sh and AgentRuntime removes chain locks only through it', () => {
    const proto = fs.readFileSync(path.join(KT, 'ChainLockProtocol.kt'), 'utf8');
    expect(proto).toContain('const val ASSET = "shelly-chain-lock.sh"');
    expect(proto).toContain('context.assets.open(ASSET)');
    expect(proto).toContain('"/system/bin/sh", "-c", script');
    expect(proto).toContain('shelly_chain_lock_reap \\"\\$1\\" \\"\\$2\\" \\"\\$3\\"');
    expect(proto).toContain('AgentScheduleReconcileCore.CHAIN_LOCK_STALE_MS / 1000');
    expect(proto).toMatch(/else -> \{[\s\S]*ReapOutcome\.LOCKED/);
    const rt = fs.readFileSync(path.join(KT, 'AgentRuntime.kt'), 'utf8');
    const fn = rt.slice(rt.indexOf('private fun clearStaleChainLock('));
    const body = fn.slice(0, fn.indexOf('\n    }\n'));
    expect(body).toContain('ChainLockProtocol.reap(context, dir)');
    expect(rt).not.toMatch(/chain\.lock[\s\S]{0,400}(renameTo|deleteRecursively)/);
    expect(rt).not.toContain('isChainLockDirStale');
  });
  it('every JS chain-lock command goes through the library', () => {
    const am = fs.readFileSync(path.join(ROOT, 'lib/agent-manager.ts'), 'utf8');
    for (const fn of ['shelly_chain_lock_acquire', 'shelly_chain_lock_release', 'shelly_chain_lock_disarm', 'shelly_chain_lock_check', 'shelly_chain_lock_discard']) {
      expect(am).toContain(fn);
    }
    expect(am).not.toContain('shelly_try_acquire_chain_lock');
    // No JS code removes a chain lock outside the protocol — deleting the
    // agent included (Codex round 1).
    const rmLines = am.split('\n').filter((l) => /rm -rf[^\n]*chain\.lock/.test(l) || /rm -rf "\$LOCK_DIR"/.test(l));
    expect(rmLines).toEqual([]);
    expect(am).toContain('shelly_chain_lock_discard "$d/locks/${agentId}.chain.lock"');
  });
});

for (const shell of ['bash', 'dash']) {
  describe(`chain-lock protocol under ${shell}`, () => {
    let n = 0;
    let P: string;
    beforeEach(() => {
      n += 1;
      fs.mkdirSync(path.join(work, shell), { recursive: true });
      P = path.join(work, shell, `agent-${n}.chain.lock`);
    });

    /** Run the library + an optional hook override + one call. */
    const run = (call: string, hook = ''): string => {
      const script = `. ${q(lib)}\n${hook ? `shelly_cl_hook() {\n${hook}\n}\n` : ''}${call}\n`;
      return execFileSync(shell, ['-c', script], { encoding: 'utf8' }).trim();
    };
    /** A command another process runs from inside a hook (plain library, no hook). */
    const other = (call: string): string => `${shell} -c ${q(`. ${q(lib)}\n${call}`)} >/dev/null`;
    const makeLock = (seed: string, acquiredAt: number, mtime?: number): void => {
      fs.mkdirSync(P);
      fs.writeFileSync(path.join(P, 'seed'), seed);
      fs.writeFileSync(path.join(P, 'token'), '');
      fs.writeFileSync(path.join(P, 'acquired-at'), String(acquiredAt));
      if (mtime != null) fs.utimesSync(P, mtime, mtime);
    };
    const seedAt = (): string | null => (fs.existsSync(path.join(P, 'seed')) ? fs.readFileSync(path.join(P, 'seed'), 'utf8') : null);
    const reap = (hook = ''): string => run(`shelly_chain_lock_reap ${q(P)} ${nowSec()} ${STALE}`, hook);
    const leftovers = (): string[] => fs.readdirSync(path.dirname(P)).filter((f) => f.startsWith(path.basename(P) + '.'));

    // ── basic outcomes ────────────────────────────────────────────────────
    it('no lock: ABSENT; a live lock: LOCKED and untouched; a stale lock: REAPED', () => {
      expect(reap()).toBe('ABSENT');
      makeLock('live', nowSec(), OLD());
      expect(reap()).toBe('LOCKED');
      expect(seedAt()).toBe('live');
      fs.rmSync(P, { recursive: true });
      makeLock('stale', OLD(), OLD());
      expect(reap()).toBe('REAPED');
      expect(fs.existsSync(P)).toBe(false);
      expect(leftovers()).toEqual([]);
    });

    it('stale policy: acquired-at just under the bound is live, at the bound stale; garbage acquired-at reads as 0', () => {
      makeLock('a', nowSec() - STALE + 5, OLD());
      expect(reap()).toBe('LOCKED');
      fs.writeFileSync(path.join(P, 'acquired-at'), 'garbage');
      fs.utimesSync(P, OLD(), OLD());
      expect(reap()).toBe('REAPED');
    });

    // ── re-gate R2: just-created lock without metadata ──────────────────────
    it('a just-created lock without metadata (fresh mtime) is never deleted by cleanup, acquire or check', () => {
      fs.mkdirSync(P);
      expect(reap()).toBe('LOCKED');
      expect(run(`shelly_chain_lock_acquire ${q(P)} other ${nowSec()} ${STALE}`)).toBe('CHAIN_LOCK_BUSY');
      expect(run(`shelly_chain_lock_check ${q(P)} ${nowSec()} ${STALE}`)).toBe('CHAIN_LOCK_BUSY');
      expect(fs.existsSync(P)).toBe(true);
      // The newborn's owner can still finish writing its metadata into it.
      fs.writeFileSync(path.join(P, 'seed'), 'newborn');
      expect(seedAt()).toBe('newborn');
    });

    it('a lock with an old acquired-at but a fresh directory (metadata just written) is not stale yet', () => {
      makeLock('fresh-dir', OLD());
      expect(reap()).toBe('LOCKED');
      expect(seedAt()).toBe('fresh-dir');
    });

    // ── re-gate R2: the interleaving, in every window of the cleanup ────────
    it('re-gate interleaving: stale A validated, then A replaced by fresh B through the protocol (another acquirer reaps A, creates B) ⇒ B survives intact, cleanup reports LOCKED; a third acquirer stays BUSY', () => {
      makeLock('A', OLD(), OLD());
      const hook = `if [ "$1" = validated ]; then ${other(`shelly_chain_lock_acquire ${q(P)} B ${nowSec()} ${STALE}`)}; fi`;
      expect(reap(hook)).toBe('LOCKED');
      expect(seedAt()).toBe('B');
      expect(Math.abs(Number(fs.readFileSync(path.join(P, 'acquired-at'), 'utf8')) - nowSec())).toBeLessThan(10);
      expect(fs.existsSync(path.join(P, 'reaping'))).toBe(false);
      expect(run(`shelly_chain_lock_acquire ${q(P)} C ${nowSec()} ${STALE}`)).toBe('CHAIN_LOCK_BUSY');
      expect(seedAt()).toBe('B');
      expect(leftovers()).toEqual([]);
    });

    it('same interleaving with a remover outside the protocol (A moved away, fresh B created) before the marker ⇒ B intact, LOCKED, marker not left in B', () => {
      makeLock('A', OLD(), OLD());
      const hook = `if [ "$1" = validated ]; then mv ${q(P)} ${q(P + '.gone')} && mkdir ${q(P)} && printf B > ${q(P + '/seed')} && printf ${nowSec()} > ${q(P + '/acquired-at')}; fi`;
      expect(reap(hook)).toBe('LOCKED');
      expect(seedAt()).toBe('B');
      expect(fs.readdirSync(P).sort()).toEqual(['acquired-at', 'seed']);
      // The marker went into A (the instance the cleanup is bound to) and was withdrawn.
      expect(fs.existsSync(path.join(P + '.gone', 'reaping'))).toBe(false);
    });

    it('after the marker is taken, nobody following the protocol can replace A: a concurrent acquirer and a second cleanup both see it held', () => {
      makeLock('A', OLD(), OLD());
      const hook =
        `if [ "$1" = marked ]; then ` +
        `${shell} -c ${q(`. ${q(lib)}\nshelly_chain_lock_reap ${q(P)} ${nowSec()} ${STALE}`)} > ${q(P + '.r2')}; ` +
        `${shell} -c ${q(`. ${q(lib)}\nshelly_chain_lock_acquire ${q(P)} X ${nowSec()} ${STALE}`)} > ${q(P + '.a2')}; fi`;
      expect(reap(hook)).toBe('REAPED');
      expect(fs.readFileSync(P + '.r2', 'utf8').trim()).toBe('LOCKED');
      expect(fs.readFileSync(P + '.a2', 'utf8').trim()).toBe('CHAIN_LOCK_BUSY');
      expect(fs.existsSync(P)).toBe(false);
    });

    it('a replacement by a remover outside the protocol AFTER the marker (instance moved, B created) ⇒ the inode check refuses, B intact', () => {
      makeLock('A', OLD(), OLD());
      const hook = `if [ "$1" = marked ]; then mv ${q(P)} ${q(P + '.gone')} && mkdir ${q(P)} && printf B > ${q(P + '/seed')}; fi`;
      expect(reap(hook)).toBe('LOCKED');
      expect(seedAt()).toBe('B');
      expect(fs.existsSync(path.join(P, 'reaping'))).toBe(false);
    });

    it('a replacement between the inode check and the move (outside the protocol) ⇒ the moved instance fails the inode re-check and is put back', () => {
      makeLock('A', OLD(), OLD());
      const hook = `if [ "$1" = pre-move ]; then mv ${q(P)} ${q(P + '.gone')} && mkdir ${q(P)} && printf B > ${q(P + '/seed')}; fi`;
      expect(reap(hook)).toBe('LOCKED');
      expect(seedAt()).toBe('B');
      expect(leftovers().filter((f) => f.includes('reaped'))).toEqual([]);
    });

    it('the owner releasing A and a new acquirer creating B while a cleanup is between validation and marker ⇒ B intact', () => {
      makeLock('A', OLD(), OLD());
      const hook =
        `if [ "$1" = validated ]; then ${other(`shelly_chain_lock_release ${q(P)} A ${nowSec()} ${STALE}`)}; ` +
        `${other(`shelly_chain_lock_acquire ${q(P)} B ${nowSec()} ${STALE}`)}; fi`;
      expect(reap(hook)).toBe('LOCKED');
      expect(seedAt()).toBe('B');
    });

    // ── interrupted cleanup (Codex round 1): a dead marker holder ────────
    it('a cleanup killed after taking the marker: its marker records a holder that is gone, so the next cleanup takes over and reaps', () => {
      makeLock('A', OLD(), OLD());
      // The holder process ends right after taking the marker (as if killed).
      const out = run(`shelly_chain_lock_reap ${q(P)} ${nowSec()} ${STALE} || true`, `if [ "$1" = marked ]; then exit 9; fi`);
      expect(out).toBe('');
      expect(fs.existsSync(path.join(P, 'reaping', 'owner'))).toBe(true);
      expect(reap()).toBe('REAPED');
      expect(fs.existsSync(P)).toBe(false);
      // …and a new chain can take the lock again.
      expect(run(`shelly_chain_lock_acquire ${q(P)} next ${nowSec()} ${STALE}`)).toBe('CHAIN_LOCK_OK');
    });

    it('a marker whose holder is alive (also a frozen one) is never taken over', async () => {
      makeLock('A', OLD(), OLD());
      const holder = spawn('sleep', ['30']);
      try {
        await new Promise((r) => setTimeout(r, 100));
        const stat = fs.readFileSync(`/proc/${holder.pid}/stat`, 'utf8').split(' ');
        fs.mkdirSync(path.join(P, 'reaping'));
        fs.writeFileSync(path.join(P, 'reaping', 'owner'), `${holder.pid} ${stat[21]}`);
        fs.utimesSync(P, OLD(), OLD());
        expect(reap()).toBe('LOCKED');
        expect(run(`shelly_chain_lock_release ${q(P)} A ${nowSec()} ${STALE}`)).toBe('');
        expect(run(`shelly_chain_lock_discard ${q(P)} ${nowSec()} ${STALE}`)).toBe('LOCKED');
        expect(seedAt()).toBe('A');
        // A record whose pid was reused (other start time) counts as gone.
        fs.writeFileSync(path.join(P, 'reaping', 'owner'), `${holder.pid} 1`);
        expect(reap()).toBe('REAPED');
      } finally {
        holder.kill('SIGKILL');
      }
    });

    it('a marker without a holder record is taken over only once it is STALE seconds old', () => {
      makeLock('A', OLD(), OLD());
      fs.mkdirSync(path.join(P, 'reaping'));
      fs.utimesSync(P, OLD(), OLD());
      expect(reap()).toBe('LOCKED');
      fs.utimesSync(path.join(P, 'reaping'), OLD(), OLD());
      fs.utimesSync(P, OLD(), OLD());
      expect(reap()).toBe('REAPED');
    });

    it('takeover is exclusive: of many concurrent cleanups of a dead-held lock exactly one reaps', async () => {
      makeLock('A', OLD(), OLD());
      fs.mkdirSync(path.join(P, 'reaping'));
      fs.writeFileSync(path.join(P, 'reaping', 'owner'), '999999 1');
      fs.utimesSync(P, OLD(), OLD());
      const outs = await Promise.all(Array.from({ length: 10 }, () => new Promise<string>((resolve) => {
        const c = spawn(shell, ['-c', `. ${q(lib)}\nshelly_chain_lock_reap ${q(P)} ${nowSec()} ${STALE}`]);
        let o = '';
        c.stdout.on('data', (d) => { o += String(d); });
        c.on('close', () => resolve(o.trim()));
      })));
      expect(outs.filter((o) => o === 'REAPED')).toHaveLength(1);
      expect(fs.existsSync(P)).toBe(false);
    });

    // Codex round 2: the publication gap and the depth cap.
    it('holder frozen before publishing its record, then taken over: on resuming it sees the takeover and yields; the instance stays with the taker', () => {
      makeLock('A', OLD(), OLD());
      // While "A" sits between mkdir and its record, a taker B creates the takeover.
      const hook = `if [ "$1" = published ] && [ "$shelly_cl_marker" = ./reaping ]; then mkdir ./reaping/takeover; fi`;
      expect(reap(hook)).toBe('LOCKED');
      expect(seedAt()).toBe('A');
      expect(fs.existsSync(path.join(P, 'reaping', 'takeover'))).toBe(true);
    });

    it('taker whose holder publishes a live record meanwhile yields and withdraws its takeover', async () => {
      makeLock('A', OLD(), OLD());
      fs.mkdirSync(path.join(P, 'reaping'));
      fs.utimesSync(path.join(P, 'reaping'), OLD(), OLD());
      fs.utimesSync(P, OLD(), OLD());
      const holder = spawn('sleep', ['30']);
      try {
        await new Promise((r) => setTimeout(r, 100));
        const st = fs.readFileSync(`/proc/${holder.pid}/stat`, 'utf8').split(' ')[21];
        // The frozen holder A resumes and publishes right after B's takeover.
        const hook = `if [ "$1" = published ] && [ "$shelly_cl_marker" = ./reaping/takeover ]; then printf '%s' '${holder.pid} ${st}' > ./reaping/owner; fi`;
        expect(reap(hook)).toBe('LOCKED');
        expect(seedAt()).toBe('A');
        expect(fs.existsSync(path.join(P, 'reaping', 'takeover'))).toBe(false);
      } finally {
        holder.kill('SIGKILL');
      }
    });

    it('any number of dead holders in a row: the next cleanup still takes over and reaps (no depth cap)', () => {
      makeLock('A', OLD(), OLD());
      let m = path.join(P, 'reaping');
      for (let k = 0; k < 8; k++) {
        fs.mkdirSync(m);
        fs.writeFileSync(path.join(m, 'owner'), '999999 1');
        m = path.join(m, 'takeover');
      }
      fs.utimesSync(P, OLD(), OLD());
      expect(reap()).toBe('REAPED');
      expect(fs.existsSync(P)).toBe(false);
    });

    it('discard (deleting the agent) removes whatever lock is there, under its marker', () => {
      expect(run(`shelly_chain_lock_discard ${q(P)} ${nowSec()} ${STALE}`)).toBe('ABSENT');
      makeLock('live', nowSec());
      expect(run(`shelly_chain_lock_discard ${q(P)} ${nowSec()} ${STALE}`)).toBe('DISCARDED');
      expect(fs.existsSync(P)).toBe(false);
      expect(leftovers()).toEqual([]);
    });

    // ── owner release / disarm ─────────────────────────────────────────────
    it('release removes only the instance holding the seed; an empty seed never matches a seedless newborn', () => {
      makeLock('mine', nowSec());
      run(`shelly_chain_lock_release ${q(P)} other ${nowSec()} ${STALE}`);
      expect(seedAt()).toBe('mine');
      expect(run(`shelly_chain_lock_release ${q(P)} mine ${nowSec()} ${STALE}`)).toBe('RELEASED');
      expect(fs.existsSync(P)).toBe(false);
      fs.mkdirSync(P);
      run(`shelly_chain_lock_release ${q(P)} '' ${nowSec()} ${STALE}`);
      expect(fs.existsSync(P)).toBe(true);
    });

    it('release while a cleanup holds the marker (the lock went stale) leaves it to that cleanup', () => {
      makeLock('mine', OLD(), OLD());
      const hook = `if [ "$1" = marked ]; then ${shell} -c ${q(`. ${q(lib)}\nshelly_chain_lock_release ${q(P)} mine ${nowSec()} ${STALE}`)} > ${q(P + '.rel')}; fi`;
      expect(reap(hook)).toBe('REAPED');
      expect(fs.readFileSync(P + '.rel', 'utf8').trim()).toBe('');
      expect(fs.existsSync(P)).toBe(false);
    });

    it('disarm clears the token only in the instance holding the seed', () => {
      makeLock('mine', nowSec());
      fs.writeFileSync(path.join(P, 'token'), 'tok');
      run(`shelly_chain_lock_disarm ${q(P)} other`);
      expect(fs.readFileSync(path.join(P, 'token'), 'utf8')).toBe('tok');
      run(`shelly_chain_lock_disarm ${q(P)} mine`);
      expect(fs.readFileSync(path.join(P, 'token'), 'utf8')).toBe('');
    });

    // ── acquire ────────────────────────────────────────────────────────────
    it('acquire writes seed / token / acquired-at; a stale lock is replaced; a live one is BUSY', () => {
      const t = nowSec();
      expect(run(`shelly_chain_lock_acquire ${q(P)} s1 ${t} ${STALE}`)).toBe('CHAIN_LOCK_OK');
      expect(seedAt()).toBe('s1');
      expect(fs.readFileSync(path.join(P, 'token'), 'utf8')).toBe('');
      expect(fs.readFileSync(path.join(P, 'acquired-at'), 'utf8')).toBe(String(t));
      expect(run(`shelly_chain_lock_acquire ${q(P)} s2 ${nowSec()} ${STALE}`)).toBe('CHAIN_LOCK_BUSY');
      fs.writeFileSync(path.join(P, 'acquired-at'), String(OLD()));
      fs.utimesSync(P, OLD(), OLD());
      expect(run(`shelly_chain_lock_acquire ${q(P)} s3 ${nowSec()} ${STALE}`)).toBe('CHAIN_LOCK_OK');
      expect(seedAt()).toBe('s3');
    });

    it('many concurrent acquirers on one stale lock: exactly one wins, and the lock on disk is the winner\'s', async () => {
      makeLock('dead', OLD(), OLD());
      const N = 12;
      const outs = await Promise.all(
        Array.from({ length: N }, (_, k) => new Promise<string>((resolve, reject) => {
          const child = spawn(shell, ['-c', `. ${q(lib)}\nshelly_chain_lock_acquire ${q(P)} w${k} ${nowSec()} ${STALE}`]);
          let out = '';
          child.stdout.on('data', (d) => { out += String(d); });
          child.on('error', reject);
          child.on('close', () => resolve(`${k}:${out.trim()}`));
        })),
      );
      const winners = outs.filter((o) => o.endsWith('CHAIN_LOCK_OK'));
      expect(winners).toHaveLength(1);
      expect(seedAt()).toBe(`w${winners[0].split(':')[0]}`);
      expect(leftovers()).toEqual([]);
    });
  });
}

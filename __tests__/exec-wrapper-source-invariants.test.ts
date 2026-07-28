/**
 * __tests__/exec-wrapper-source-invariants.test.ts
 *
 * modules/terminal-emulator/android/src/main/jni/exec-wrapper.c is the
 * LD_PRELOAD shim that launders app-data binary execution through
 * /system/bin/linker64 (Android denies `exec` on `app_data_file`). It cannot be
 * compiled, let alone run, in this repo's JS toolchain — CI builds it via the
 * NDK, and the only runtime is a physical device. Two fixes therefore sit in
 * docs/superpowers/DEFERRED.md as "committed, on-device verification pending":
 *
 *   • bug #119 — the is_elf() TOCTOU window (`c7a39c20c`)
 *   • the MAX_ARGC / MAX_ENVP stack-frame SIGSEGV (`0eb30a995`)
 *
 * This suite is the strongest check available without a device: it asserts the
 * STRUCTURAL properties each fix depends on directly against the source, so a
 * future edit that reopens either hole fails in CI instead of silently
 * regressing a security boundary that nobody can smoke-test locally.
 *
 * It deliberately does NOT try to be a C parser. Every assertion is a narrow
 * pin on a specific line the fix introduced.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC_PATH = path.resolve(
  __dirname,
  '../modules/terminal-emulator/android/src/main/jni/exec-wrapper.c',
);
const src = fs.readFileSync(SRC_PATH, 'utf8');
/** Same source with C comments blanked out — for "this identifier is gone" checks. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** Extract a `static <ret> <name>(…) { … }` body by brace matching. */
function functionBody(name: string): string {
  const decl = new RegExp(`static\\s+[\\w *]+?\\b${name}\\s*\\(`).exec(src);
  if (!decl) throw new Error(`function ${name} not found in exec-wrapper.c`);
  const open = src.indexOf('{', src.indexOf(')', decl.index));
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(open, i + 1);
}

const macros: Record<string, number> = {};
for (const m of src.matchAll(/^#define\s+(MAX_ARGC|MAX_ENVP|PATH_BUF_SIZE|PROC_FD_PATH_SIZE|ELF_FD_MIN)\s+(\d+)/gm)) {
  macros[m[1]] = Number(m[2]);
}

// ---------------------------------------------------------------------------
// bug #119 — TOCTOU between the ELF-magic check and the exec
// ---------------------------------------------------------------------------
describe('bug #119: the ELF check and the exec must share one pinned fd', () => {
  it('has no path-based is_elf()/should_linker_exec() helper left', () => {
    // The vulnerable shape was: is_elf(path) → open/read/close → later
    // execve(LINKER64, {LINKER64, path, …}), where linker64 re-resolved `path`
    // by NAME. Anything able to swap that name in between (symlink flip,
    // rename) got a different inode executed than the one that was checked.
    // (checked against the comment-stripped source: the fix's own doc comment
    // names the removed helper on purpose)
    expect(code).not.toMatch(/\bis_elf\s*\(/);
    expect(code).not.toMatch(/\bshould_linker_exec\s*\(/);
  });

  it('open_verified_elf_fd() verifies the magic on the fd it returns, and never re-opens by path', () => {
    const body = functionBody('open_verified_elf_fd');
    // exactly one open, and it is the fd the magic is read from
    expect((body.match(/raw_open_readonly\(/g) ?? []).length).toBe(1);
    expect(body).toMatch(/int fd = raw_open_readonly\(path\);/);
    expect(body).toMatch(/n = raw_read_call\(fd, magic, sizeof\(magic\)\);/);
    // EINTR retry so a signal cannot turn a good ELF into a "not ELF" verdict
    expect(body).toMatch(/while \(n == -SHELLY_EINTR\)/);
    expect(body).toMatch(/magic\[0\] != 0x7f .*\n?.*magic\[1\] != 'E'/);
    // the ONLY close on the success path is the original fd after F_DUPFD —
    // i.e. the verified open file description itself is never closed before exec
    expect(body).toMatch(/int high_fd = raw_fcntl_dupfd\(fd, ELF_FD_MIN\);/);
    expect(body).toMatch(/return high_fd;/);
    expect(body).toMatch(/return fd;/);
    // O_CLOEXEC would defeat the whole design: the fd MUST survive execve so
    // linker64 in the new image can open /proc/self/fd/N.
    expect(body).not.toMatch(/O_CLOEXEC/);
  });

  it('raw_open_readonly() passes O_RDONLY only — no O_CLOEXEC, no write bits', () => {
    expect(functionBody('raw_open_readonly')).toMatch(
      /raw_syscall4\(__NR_openat, AT_FDCWD, \(long\)path, O_RDONLY, 0\)/,
    );
  });

  it('the dup target is above the stdio range so spawn file_actions cannot clobber it', () => {
    expect(macros.ELF_FD_MIN).toBeGreaterThanOrEqual(3);
    // Documented as a heuristic, not a proof — posix_spawn file_actions run in
    // the child and could still addclose/adddup2 an arbitrary fd number. A
    // clobber makes the exec FAIL (linker64 cannot open /proc/self/fd/N); it
    // does not silently run a different inode, because the pinned fd is the
    // only thing the argv names.
    expect(macros.ELF_FD_MIN).toBeGreaterThanOrEqual(100);
  });

  it('formats the exec target as /proc/self/fd/N, the fexecve-equivalent form', () => {
    // Opening /proc/self/fd/N is a magic-symlink jump straight to the open
    // file description's dentry — it is NOT a fresh pathname walk. This is
    // precisely how glibc implements fexecve(), and it is what makes the
    // check-to-use window structurally unreachable.
    const body = functionBody('format_proc_fd_path');
    expect(body).toMatch(/"\/proc\/self\/fd\/"/);
    expect(body).toMatch(/append_uint\(out, out_size, &n, \(unsigned int\)fd\)/);
  });

  it('both exec entry points hand linker64 the fd path, never the mutable pathname', () => {
    for (const fn of ['shelly_execve_internal', 'shelly_posix_spawn_common']) {
      const body = functionBody(fn);
      // linker argv[1] is built from elf_fd_path…
      expect(body).toMatch(/format_proc_fd_path\(elf_fd_path, sizeof\(elf_fd_path\), elf_fd\) != 0 \|\|\s*\n?\s*build_linker_argv\(elf_fd_path, argv, new_argv\) != 0/);
      // …and `rewritten` only ever reaches a DIRECT exec (which the kernel
      // resolves atomically, so it has no window of its own).
      expect(body).not.toMatch(/build_linker_argv\(rewritten, argv, new_argv\)/);
    }
  });

  it('closes the verified fd on every branch that does not exec through it', () => {
    // Leaking it would keep a read-only descriptor to the binary open in the
    // long-lived parent. Non-exec branches: the codex fs-helper self-exec
    // (spawns by path, unchanged argv contract) in both entry points, the two
    // build_linker_argv-failure fallbacks, and the parent side after each
    // posix_spawn.
    expect((src.match(/close_elf_fd\(elf_fd\);/g) ?? []).length).toBeGreaterThanOrEqual(7);
    // The is_codex_fs_helper_LINKER_exec branch does not close, and must not
    // need to: linker_exec_elf_fd() returns -1 for LINKER64, so elf_fd is -1
    // there by construction.
    expect(functionBody('linker_exec_elf_fd')).toMatch(/streq\(pathname, LINKER64\)/);
  });

  it('keeps the build marker that identifies the fd-pinned wrapper on-device', () => {
    expect(src).toMatch(/"shelly-exec-wrapper:v\d+:fd-pinned-linker-exec"/);
  });
});

// ---------------------------------------------------------------------------
// MAX_ARGC / MAX_ENVP stack-frame SIGSEGV
// ---------------------------------------------------------------------------
describe('exec-wrapper stack budget (forked-child SIGSEGV fix)', () => {
  /**
   * Sum every on-stack array declared inside a function. This is the WORST
   * case — it assumes the compiler performs no stack colouring at all, i.e.
   * that scopes with disjoint lifetimes each get their own slot. Real -O2
   * builds reuse slots, so the true frame is smaller; asserting the worst case
   * is the conservative direction for a file that cannot be compiled here.
   */
  function worstCaseFrameBytes(fn: string): number {
    const body = functionBody(fn);
    let total = 0;
    for (const m of body.matchAll(/^\s*(char \*|char )\s*[A-Za-z_]\w*\s*\[([^\]]+)\]\s*;/gm)) {
      const isPointerArray = m[1].includes('*');
      const count = Function(
        'MAX_ARGC',
        'MAX_ENVP',
        'PATH_BUF_SIZE',
        'PROC_FD_PATH_SIZE',
        `return (${m[2]});`,
      )(macros.MAX_ARGC, macros.MAX_ENVP, macros.PATH_BUF_SIZE, macros.PROC_FD_PATH_SIZE) as number;
      total += count * (isPointerArray ? 8 : 1); // aarch64: sizeof(char *) == 8
    }
    return total;
  }

  it('keeps the argv/envp caps at the reduced values', () => {
    // Regression lock for `0eb30a995`. Both were 4096, which put the worst
    // case at ~284 KB (execve) / ~328 KB (posix_spawn).
    expect(macros.MAX_ARGC).toBeLessThanOrEqual(1024);
    expect(macros.MAX_ENVP).toBeLessThanOrEqual(512);
  });

  it('keeps each exec frame under 96 KB even with zero stack colouring', () => {
    // Why 96 KB: bionic's default pthread stack is 1 MB (the main thread gets
    // RLIMIT_STACK, 8 MB), so 96 KB is <10% of the smallest realistic stack.
    // This matters more than the absolute number because the file is built
    // with -fno-stack-protector AND without -fstack-clash-protection (see
    // modules/terminal-emulator/android/CMakeLists.txt), so a large frame is
    // allocated with a single `sub sp, sp, #N` that can step straight OVER
    // the 4 KB guard page instead of faulting on it. Keeping the frame small
    // relative to the guard page is the mitigation.
    const execve = worstCaseFrameBytes('shelly_execve_internal');
    const spawn = worstCaseFrameBytes('shelly_posix_spawn_common');
    expect(execve).toBeLessThan(96 * 1024);
    expect(spawn).toBeLessThan(96 * 1024);
    // sanity: the inventory actually found the big arrays
    expect(execve).toBeGreaterThan(32 * 1024);
    expect(spawn).toBeGreaterThan(32 * 1024);
  });

  it('guards every envp copy loop against a silently truncated array', () => {
    // The subtle part of `0eb30a995`: `i == MAX_ENVP` after the loop is
    // ambiguous between "ended exactly at the cap" and "was truncated", so the
    // guard has to peek at source[i] itself. All four copy loops need it.
    const guards = src.match(/if \(i == MAX_ENVP && source\[i\] != NULL\) return -1;/g) ?? [];
    expect(guards.length).toBe(4);
    for (const fn of [
      'scrub_system_envp',
      'scrub_codex_child_envp',
      'add_app_loader_envp',
      'add_codex_helper_envp',
    ]) {
      expect(functionBody(fn)).toMatch(/if \(i == MAX_ENVP && source\[i\] != NULL\) return -1;/);
    }
  });

  it('bounds the argv walk so a caller cannot overrun the on-stack argv copy', () => {
    for (const fn of ['build_linker_argv', 'build_codex_fs_helper_argv']) {
      const body = functionBody(fn);
      expect(body).toMatch(/while \(argc < MAX_ARGC && argv\[argc\]\) argc\+\+;/);
      expect(body).toMatch(/if \(argc >= MAX_ARGC\) return -1;/);
    }
    // the destination arrays are MAX_ARGC + 2 (LINKER64 + target + NULL)
    expect((src.match(/\[MAX_ARGC \+ 2\]/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

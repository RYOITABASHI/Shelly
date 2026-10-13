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
    // v221/v222 added a fifth copy loop (ensure_wrapper_envp).
    expect(guards.length).toBe(5);
    for (const fn of [
      'scrub_system_envp',
      'scrub_codex_child_envp',
      'add_app_loader_envp',
      'add_codex_helper_envp',
      'ensure_wrapper_envp',
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

// ---------------------------------------------------------------------------
// v220 — execvp() must pass the caller's live environ; /system-backed fds must
// not be handed to linker64 (on-device evidence: docs/superpowers/DEFERRED.md
// "Codex 内で実行したコマンドに PYTHONHOME/PYTHONPATH が渡らない")
// ---------------------------------------------------------------------------
describe('v220: execvp() preserves the spawner environment', () => {
  it('resolves libc environ by name in the constructor (no GLOB_DAT relocation)', () => {
    // CI rejects any R_AARCH64_GLOB_DAT against `environ` (see
    // .github/workflows/build-android.yml), so the pointer must come from
    // dlsym — never from an `extern char **environ` declaration.
    expect(code).not.toMatch(/extern\s+char\s*\*\*\s*environ/);
    const ctor = functionBody('shelly_resolve_real_impls');
    // RTLD_DEFAULT first (a copy-relocated executable `environ` is the one the
    // program writes to), RTLD_NEXT as the fallback.
    expect(ctor).toMatch(/g_environ_ptr = \(char \*\*\*\)dlsym\(RTLD_DEFAULT, "environ"\);/);
    expect(ctor).toMatch(/if \(!g_environ_ptr\) g_environ_ptr = \(char \*\*\*\)dlsym\(RTLD_NEXT, "environ"\);/);
  });

  it('only execvp() reads environ; no entry point merges parent values into a supplied envp', () => {
    // 2b5204037 removed env_value_parent_fallback() because a scrubbed Codex
    // child env was being re-polluted from the parent. caller_environ() must
    // stay confined to execvp(), whose POSIX definition IS "execve with environ".
    expect(code).not.toMatch(/env_value_parent_fallback/);
    const uses = code.match(/caller_environ\(\)/g) ?? [];
    expect(uses.length).toBe(1);
    const execvpStart = code.indexOf('int execvp(const char *file, char *const argv[])');
    expect(code.indexOf('caller_environ()')).toBeGreaterThan(execvpStart);
  });

  it('execvp() hands shelly_execve_internal the live environ, not NULL', () => {
    const start = src.indexOf('int execvp(const char *file, char *const argv[])');
    expect(start).toBeGreaterThan(0);
    const endRel = src.slice(start).search(/\r?\n\}\r?\n/);
    expect(endRel).toBeGreaterThan(0);
    const body = src.slice(start, start + endRel + 2);
    // Rust std (Command + pre_exec → fork/execvp, which is how Codex spawns
    // every tool command) and libuv set `environ = child_env` right before
    // execvp(); a NULL here silently substituted minimal_envp and dropped
    // PYTHONHOME/PYTHONPATH/TZ/SHELLY_CODEX_* for the child.
    expect(body).toMatch(/char \*const \*envp = caller_environ\(\);/);
    expect(body).toMatch(/resolve_path_search\(file, envp, resolved_buf/);
    expect(body).toMatch(/return shelly_execve_internal\(path, argv, envp\);/);
    expect(body).not.toMatch(/shelly_execve_internal\(path, argv, NULL\)/);
  });

  it('caller_environ() degrades to NULL (legacy behaviour) only when dlsym failed', () => {
    const body = functionBody('caller_environ');
    expect(body).toMatch(/if \(!g_environ_ptr\) return NULL;/);
    expect(body).toMatch(/return \(char \*const \*\)\*g_environ_ptr;/);
  });
});

describe('v220: system-image targets are never exec\'d through /proc/self/fd/N', () => {
  it('fd_targets_system_image() readlinks the pinned fd itself, not the pathname', () => {
    // The check has to look at the open file description (the same magic
    // link linker64 would be given), so it stays TOCTOU-free like bug #119.
    const body = functionBody('fd_targets_system_image');
    expect(body).toMatch(/format_proc_fd_path\(proc_path, sizeof\(proc_path\), fd\)/);
    expect(body).toMatch(/raw_readlinkat_call\(AT_FDCWD, proc_path, resolved, resolved_size - 1\)/);
    expect(body).toMatch(/while \(n == -SHELLY_EINTR\)/);
    expect(body).toMatch(/system_image_path\(resolved\)/);
  });

  it('system_image_path() covers /system, /vendor and /apex', () => {
    const body = functionBody('system_image_path');
    for (const prefix of ['/system/', '/vendor/', '/apex/']) {
      expect(body).toContain(`"${prefix}"`);
    }
  });

  it('linker_exec_elf_fd() closes the fd and reports the resolved target for system images', () => {
    const body = functionBody('linker_exec_elf_fd');
    expect(body).toMatch(/fd = open_verified_elf_fd\(pathname\);/);
    expect(body).toMatch(
      /if \(system_target && fd_targets_system_image\(fd, system_target, system_target_size\)\) \{\s*\n\s*raw_close_call\(fd\);\s*\n\s*return -1;/,
    );
  });

  it('both exec entry points exec the resolved /system path directly in that case', () => {
    for (const fn of ['shelly_execve_internal', 'shelly_posix_spawn_common']) {
      const body = functionBody(fn);
      expect(body).toMatch(/linker_exec_elf_fd\(rewritten, system_target, sizeof\(system_target\)\)/);
      expect(body).toMatch(/if \(elf_fd < 0 && system_target\[0\]\) \{[\s\S]*?rewritten = system_target;/);
      // and the direct-exec branches below still key off `rewritten`
      expect(body).toMatch(/should_scrub_system_env\(rewritten\)/);
    }
  });

  it('keeps the v220 build marker CI checks for', () => {
    expect(src).toContain('"shelly-exec-wrapper:v220:execvp-environ+system-target-direct"');
  });
});

// ---------------------------------------------------------------------------
// v221 — /system exec-a-child helpers keep the wrapper (build 2524 finding:
// `!env python3 -c ...` → `coreutils: 'python3': Permission denied`)
// ---------------------------------------------------------------------------
describe('v221: toybox env/nice/nohup/setsid/time/timeout/xargs keep LD_PRELOAD', () => {
  it('lists exactly the helpers that exist on device and exec a child', () => {
    const body = functionBody('should_keep_wrapper_for_helper_path');
    expect(body).toMatch(/trusted_shell_path\(path\)/);
    for (const name of ['env', 'nice', 'nohup', 'setsid', 'time', 'timeout', 'xargs']) {
      expect(body).toContain(`streq(base, "${name}")`);
    }
    // not a generic allow-list: nothing that merely reads files
    expect(body).not.toMatch(/"(cat|grep|sh|bash)"/);
  });

  it('ensure_wrapper_envp(..., 1) drops LD_LIBRARY_PATH but guarantees LD_PRELOAD', () => {
    const body = functionBody('ensure_wrapper_envp');
    expect(body).toMatch(/if \(drop_ld_library_path && starts_with\(source\[i\], "LD_LIBRARY_PATH="\)\) continue;/);
    expect(body).toMatch(/if \(!has_ld_preload\) out\[n\+\+\] = default_ld_preload_env;/);
    // NULL envp falls back to the wrapper-carrying minimal env, not minimal_envp
    expect(body).toMatch(/source = envp \? envp : minimal_wrapper_envp;/);
  });

  it('both entry points route helpers through the helper scrub before the generic /system scrub', () => {
    for (const fn of ['shelly_execve_internal', 'shelly_posix_spawn_common']) {
      const body = functionBody(fn);
      expect(body).toMatch(/keep_wrapper_for_helper = should_keep_wrapper_for_helper_path\(rewritten\);/);
      // codex-mode scrub keeps the wrapper for helpers too
      expect(body).toMatch(/keep_wrapper_for_shell \|\| keep_wrapper_for_helper\) == 0\)/);
      const helperIdx = body.indexOf('ensure_wrapper_envp(envp, scrubbed_env, 1)');
      const genericIdx = body.indexOf('scrub_system_envp(envp, scrubbed_env)');
      expect(helperIdx).toBeGreaterThan(0);
      expect(genericIdx).toBeGreaterThan(helperIdx);
    }
  });

  it('system_image_path() also covers /system_ext, /product and /odm, and should_scrub_system_env reuses it', () => {
    const body = functionBody('system_image_path');
    for (const prefix of ['/system_ext/', '/product/', '/odm/']) {
      expect(body).toContain(`"${prefix}"`);
    }
    expect(functionBody('should_scrub_system_env')).toMatch(/system_image_path\(pathname\)/);
  });

  it('keeps the v221 build marker CI checks for', () => {
    expect(src).toContain('"shelly-exec-wrapper:v221:system-helpers-keep-wrapper"');
    expect(src).toMatch(/"shelly-exec-wrapper:v222:fd-pinned-linker-exec"/);
  });
});

// ---------------------------------------------------------------------------
// v222 — wrapper self-propagation (build 2525: Codex's `bash -lc` sources
// ~/.bashrc, which `unset LD_PRELOAD`; its children then exec'd un-laundered)
// ---------------------------------------------------------------------------
describe('v222: a wrapper-loaded process re-propagates LD_PRELOAD to laundered children', () => {
  it('add_app_loader_envp() takes separate include_ld / include_wrapper flags', () => {
    const body = functionBody('add_app_loader_envp');
    expect(src).toMatch(/static int add_app_loader_envp\(char \*const envp\[\], char \*\*out, char \*ld_buf, size_t ld_buf_size,\s*\n\s*int include_ld, int include_wrapper\)/);
    expect(body).toMatch(/if \(include_ld\) out\[n\+\+\] = ld_buf;/);
    expect(body).toMatch(/if \(include_wrapper\) \{/);
  });

  it('the fd-pinned linker exec adds LD_PRELOAD whenever the envp lacks it, in both entry points', () => {
    for (const fn of ['shelly_execve_internal', 'shelly_posix_spawn_common']) {
      const body = functionBody(fn);
      expect(body).toMatch(/int need_wrapper = !env_value\(envp, "LD_PRELOAD="\);/);
      expect(body).toMatch(/add_app_loader_envp\(envp, app_env, ld_buf, sizeof\(ld_buf\),\s*\n\s*need_ld, need_wrapper\)/);
      // the old "only when envp is NULL" gate is gone
      expect(body).not.toMatch(/!envp && keep_wrapper_for_shell\) == 0\)/);
    }
  });

  it('explicit `linker64 <app-data ELF>` execs (bashrc _run) and /system shells also get the wrapper', () => {
    const pred = functionBody('explicit_linker_app_elf_exec');
    expect(pred).toMatch(/streq\(pathname, LINKER64\)/);
    expect(pred).toMatch(/trusted_codex_path\(argv\[1\]\)/);
    for (const fn of ['shelly_execve_internal', 'shelly_posix_spawn_common']) {
      const body = functionBody(fn);
      expect(body).toMatch(/explicit_linker_app_elf_exec\(rewritten, argv\) && !env_value\(envp, "LD_PRELOAD="\) &&\s*\n\s*ensure_wrapper_envp\(envp, scrubbed_env, 0\) == 0/);
      expect(body).toMatch(/keep_wrapper_for_shell && should_scrub_system_env\(rewritten\)\) \{[\s\S]*?ensure_wrapper_envp\(envp, scrubbed_env, 0\) == 0/);
    }
  });

  it('non-helper /system binaries are still scrubbed (LD_* removed)', () => {
    for (const fn of ['shelly_execve_internal', 'shelly_posix_spawn_common']) {
      expect(functionBody(fn)).toMatch(/should_scrub_system_env\(rewritten\) &&\s*\n\s*scrub_system_envp\(envp, scrubbed_env\) == 0/);
    }
    const scrub = functionBody('scrub_system_envp');
    expect(scrub).toMatch(/starts_with\(source\[i\], "LD_PRELOAD="\)\) \{\s*\n\s*continue;/);
  });

  it('keeps the v222 build marker CI checks for', () => {
    expect(src).toContain('"shelly-exec-wrapper:v222:wrapper-self-propagation"');
  });
});

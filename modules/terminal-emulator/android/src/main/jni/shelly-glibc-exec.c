/*
 * shelly-glibc-exec.c
 *
 * Userland loader (ulexec-style) for the official, UNMODIFIED Claude Code
 * linux-arm64 glibc binary on Samsung Knox / targetSdk 36, where neither a
 * raw execve of an app_data_file (W^X) nor the bionic linker64 invoking the
 * glibc ld.so directly works.
 *
 * Background (on-device spike, Fold6 build 2679 — see DEFERRED.md
 * "Claude Code 公式 glibc 版（2.1.314）"):
 *   (1) `linker64 ld-linux-aarch64.so.1`         -> "Could not find a PHDR"
 *   (2) ld.so + a synthetic PT_PHDR              -> SIGSEGV (glibc's ld.so
 *       expects the KERNEL to have started it, i.e. auxv AT_PHDR/AT_BASE/
 *       AT_ENTRY describe ld.so itself; via linker64 it sees linker64's auxv).
 *   (3) raw execve of any app_data_file          -> EACCES (W^X).
 *   (4) mmap(PROT_EXEC) of an app_data_file       -> ALLOWED (this is how
 *       linker64 already loads files/termux-libs/libbash.so).
 *
 * So: this helper is itself a plain bionic PIE launched the same way as the
 * other native helpers — `/system/bin/linker64 $libDir/<loader> <ld.so>
 * [ld.so args...] <program> [args...]`. In-process it mmaps the glibc ld.so
 * from (4), builds a fresh stack whose argc/argv/envp/auxv look exactly like
 * a kernel exec of ld.so "invoked as a program" (so ld.so itself loads the
 * target program, applying its own relocations), resets the signal state
 * bionic installed, and jumps to ld.so's e_entry. bionic's state is simply
 * abandoned after the jump.
 *
 * We deliberately load ONLY ld.so here (not the target program). ld.so, run
 * "as a program", treats its first non-option argv entry as the program to
 * load and does all the heavy lifting (program mapping, its own + the
 * program's relocations, TLS, etc.). This keeps the loader tiny and means we
 * never touch the Claude Code binary (no patching/decoding — ToS-clean).
 *
 * Prior art studied (not vendored; GPL/MIT-licensed, re-implemented from the
 * public technique): tribixbite/bun-on-termux userland loader, termux-exec's
 * system_linker_exec, classic "ulexec" loaders.
 *
 * Argument contract (argv as THIS process sees it):
 *   argv[0] = <this loader's own path>  (ignored)
 *   argv[1] = <absolute path to glibc ld-linux-aarch64.so.1>
 *   argv[2..] = the args to hand ld.so, e.g.
 *               --library-path <dir> <program> [program args...]
 *
 * Env contract:
 *   - The bionic-world LD_PRELOAD / LD_LIBRARY_PATH are dropped from the
 *     child env (they would poison glibc's loader).
 *   - SHELLY_GLIBC_LD_LIBRARY_PATH, if set, is forwarded as LD_LIBRARY_PATH
 *     to the glibc world.
 *
 * Exit codes: 2 on any loader-side setup failure (with a clear stderr
 * message prefixed "shelly-glibc-exec:"). On success this function never
 * returns — control is transferred to ld.so.
 */

#define _GNU_SOURCE
#include <elf.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/auxv.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

/* Provided by the C runtime / kernel: the real environment and auxv. */
extern char **environ;

#define LOADER_TAG "shelly-glibc-exec"

static void die(const char *fmt, ...) __attribute__((noreturn));
static void die(const char *fmt, ...) {
    va_list ap;
    fprintf(stderr, "%s: ", LOADER_TAG);
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    if (fmt[0] && fmt[strlen(fmt) - 1] != '\n')
        fputc('\n', stderr);
    _exit(2);
}

/* Round helpers. All sizes here are page-granular. */
static size_t g_pagesz;

static inline uintptr_t page_down(uintptr_t v) { return v & ~(uintptr_t)(g_pagesz - 1); }
static inline uintptr_t page_up(uintptr_t v) { return (v + g_pagesz - 1) & ~(uintptr_t)(g_pagesz - 1); }

static int prot_of(uint32_t p_flags) {
    int prot = 0;
    if (p_flags & PF_R) prot |= PROT_READ;
    if (p_flags & PF_W) prot |= PROT_WRITE;
    if (p_flags & PF_X) prot |= PROT_EXEC;
    return prot;
}

/*
 * Map a PT_INTERP-less ELF (the glibc ld.so is ET_DYN, i.e. a PIE/shared
 * object) at a kernel-chosen base. Returns the load bias (base) and fills in
 * the entry point, PHDR address, phentsize/phnum for the mapped image.
 *
 * Strategy: reserve the whole [min_vaddr, max_vaddr) span with one anonymous
 * PROT_NONE mapping to get a contiguous base, then MAP_FIXED each PT_LOAD
 * segment from the fd over that reservation with the right protections,
 * zero-filling the part of the last page past p_filesz and mapping extra
 * anonymous pages for the bss tail (p_memsz > p_filesz).
 */
typedef struct {
    uintptr_t base;       /* load bias */
    uintptr_t entry;      /* absolute entry point */
    uintptr_t phdr;       /* absolute address of the program headers in memory */
    uint16_t phentsize;
    uint16_t phnum;
} mapped_elf_t;

static void map_elf(const char *path, mapped_elf_t *out) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0)
        die("open(%s): %s", path, strerror(errno));

    Elf64_Ehdr eh;
    ssize_t n = pread(fd, &eh, sizeof(eh), 0);
    if (n != (ssize_t)sizeof(eh))
        die("short read of ELF header from %s", path);

    if (memcmp(eh.e_ident, ELFMAG, SELFMAG) != 0)
        die("%s is not an ELF file", path);
    if (eh.e_ident[EI_CLASS] != ELFCLASS64 || eh.e_ident[EI_DATA] != ELFDATA2LSB)
        die("%s is not a 64-bit little-endian ELF", path);
    if (eh.e_machine != EM_AARCH64)
        die("%s is not aarch64 (e_machine=%u)", path, (unsigned)eh.e_machine);
    if (eh.e_type != ET_DYN)
        die("%s is not ET_DYN (ld.so must be a shared object)", path);
    if (eh.e_phentsize != sizeof(Elf64_Phdr))
        die("%s has unexpected e_phentsize %u", path, (unsigned)eh.e_phentsize);
    if (eh.e_phnum == 0 || eh.e_phnum > 256)
        die("%s has implausible e_phnum %u", path, (unsigned)eh.e_phnum);

    size_t ph_bytes = (size_t)eh.e_phnum * sizeof(Elf64_Phdr);
    Elf64_Phdr *ph = malloc(ph_bytes);
    if (!ph)
        die("out of memory for program headers");
    n = pread(fd, ph, ph_bytes, (off_t)eh.e_phoff);
    if (n != (ssize_t)ph_bytes)
        die("short read of program headers from %s", path);

    /* Compute the full virtual span covered by PT_LOAD segments. */
    uintptr_t min_vaddr = UINTPTR_MAX, max_vaddr = 0;
    int have_load = 0;
    for (uint16_t i = 0; i < eh.e_phnum; i++) {
        if (ph[i].p_type != PT_LOAD)
            continue;
        have_load = 1;
        if (ph[i].p_vaddr < min_vaddr)
            min_vaddr = ph[i].p_vaddr;
        uintptr_t end = (uintptr_t)ph[i].p_vaddr + ph[i].p_memsz;
        if (end > max_vaddr)
            max_vaddr = end;
    }
    if (!have_load)
        die("%s has no PT_LOAD segments", path);

    uintptr_t span_start = page_down(min_vaddr);
    uintptr_t span_end = page_up(max_vaddr);
    size_t span = span_end - span_start;

    /* Reserve the whole span so all segments land contiguously. */
    void *reserve = mmap(NULL, span, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (reserve == MAP_FAILED)
        die("reserve mmap(%zu): %s", span, strerror(errno));

    uintptr_t bias = (uintptr_t)reserve - span_start;

    for (uint16_t i = 0; i < eh.e_phnum; i++) {
        if (ph[i].p_type != PT_LOAD)
            continue;

        uintptr_t seg_vaddr = (uintptr_t)ph[i].p_vaddr + bias;
        uintptr_t map_start = page_down(seg_vaddr);
        uintptr_t file_end = seg_vaddr + ph[i].p_filesz;
        uintptr_t map_file_end = page_up(file_end);
        off_t file_off = page_down((uintptr_t)ph[i].p_offset);
        /* Offset must stay congruent to vaddr modulo page size for the file
         * mapping to land correctly; the ELF spec guarantees
         * p_offset % pagesz == p_vaddr % pagesz. */
        int prot = prot_of(ph[i].p_flags);

        if (ph[i].p_filesz > 0) {
            size_t len = map_file_end - map_start;
            /* Map file-backed pages writable first so we can zero the slack
             * past p_filesz on the final page, then restore protection. */
            void *m = mmap((void *)map_start, len, prot | PROT_WRITE,
                           MAP_PRIVATE | MAP_FIXED, fd, file_off);
            if (m == MAP_FAILED)
                die("segment mmap @%p len %zu: %s", (void *)map_start, len, strerror(errno));

            /* Zero the bytes from file_end up to the end of its page. */
            uintptr_t page_after_file = page_up(file_end);
            if (page_after_file > file_end)
                memset((void *)file_end, 0, page_after_file - file_end);

            if (!(prot & PROT_WRITE)) {
                if (mprotect((void *)map_start, len, prot) != 0)
                    die("mprotect segment @%p: %s", (void *)map_start, strerror(errno));
            }
        }

        /* bss tail: anonymous zero pages for [file_end_page, mem_end_page). */
        uintptr_t mem_end = seg_vaddr + ph[i].p_memsz;
        uintptr_t map_mem_end = page_up(mem_end);
        uintptr_t bss_start = (ph[i].p_filesz > 0) ? map_file_end : map_start;
        if (map_mem_end > bss_start) {
            size_t bss_len = map_mem_end - bss_start;
            void *b = mmap((void *)bss_start, bss_len, prot | PROT_WRITE,
                           MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);
            if (b == MAP_FAILED)
                die("bss mmap @%p len %zu: %s", (void *)bss_start, bss_len, strerror(errno));
            if (!(prot & PROT_WRITE)) {
                if (mprotect((void *)bss_start, bss_len, prot) != 0)
                    die("mprotect bss @%p: %s", (void *)bss_start, strerror(errno));
            }
        }
    }

    out->base = bias;
    out->entry = (uintptr_t)eh.e_entry + bias;
    out->phdr = (uintptr_t)eh.e_phoff + bias; /* phoff lives inside the first PT_LOAD at file offset 0 */
    out->phentsize = eh.e_phentsize;
    out->phnum = eh.e_phnum;

    free(ph);
    close(fd);
}

/* ------------------------------------------------------------------ */
/* Stack construction: a kernel-style initial stack for ld.so.         */
/* Layout (low -> high): argc, argv[], NULL, envp[], NULL, auxv[],     */
/* then the string/data area the pointers reference. We allocate a     */
/* dedicated stack region, fill it, and jump with sp pointing at argc. */
/* ------------------------------------------------------------------ */

/* Read the real auxv from /proc/self/auxv so we can copy hardware/system
 * entries (AT_HWCAP, AT_CLKTCK, AT_SYSINFO_EHDR, ...) the kernel gave us. */
typedef struct { uint64_t a_type; uint64_t a_val; } auxpair_t;

static size_t read_real_auxv(auxpair_t *buf, size_t max) {
    int fd = open("/proc/self/auxv", O_RDONLY | O_CLOEXEC);
    if (fd < 0)
        return 0;
    size_t count = 0;
    while (count < max) {
        auxpair_t p;
        ssize_t r = read(fd, &p, sizeof(p));
        if (r != (ssize_t)sizeof(p))
            break;
        buf[count++] = p;
        if (p.a_type == AT_NULL)
            break;
    }
    close(fd);
    return count;
}

static uint64_t find_real_aux(const auxpair_t *av, size_t n, uint64_t type, uint64_t fallback) {
    for (size_t i = 0; i < n; i++)
        if (av[i].a_type == type)
            return av[i].a_val;
    return fallback;
}

/* Jump to ld.so's entry with a freshly built stack. Defined in asm below. */
extern void shelly_glibc_trampoline(void *sp, uintptr_t entry) __attribute__((noreturn));

int main(int argc, char **argv) {
    (void)argc;
    g_pagesz = (size_t)sysconf(_SC_PAGESIZE);
    if (g_pagesz == 0 || (g_pagesz & (g_pagesz - 1)) != 0)
        g_pagesz = 4096;

    if (argc < 3)
        die("usage: %s <ld.so> [ld.so args...] <program> [args...]", argv[0]);

    const char *ldso_path = argv[1];

    /* Map the glibc ld.so. */
    mapped_elf_t ld;
    map_elf(ldso_path, &ld);

    /*
     * Build the child argv: ld.so runs "as a program", so its argv[0] is the
     * ld.so path and the rest are ld.so's own arguments (which include the
     * target program path and its args). That is exactly argv[1..] of THIS
     * process. So child_argv = &argv[1], child_argc = argc - 1.
     */
    char **child_argv = &argv[1];
    int child_argc = argc - 1;

    /*
     * Build the child envp: copy current environ, dropping the bionic-world
     * LD_PRELOAD and LD_LIBRARY_PATH, and translating
     * SHELLY_GLIBC_LD_LIBRARY_PATH -> LD_LIBRARY_PATH for the glibc world.
     */
    size_t env_count = 0;
    for (char **e = environ; *e; e++)
        env_count++;

    /* +1 slot in case we add a translated LD_LIBRARY_PATH, +1 for NULL. */
    char **child_envp = malloc((env_count + 2) * sizeof(char *));
    if (!child_envp)
        die("out of memory for envp");

    const char *fwd_libpath = NULL;
    size_t ce = 0;
    for (char **e = environ; *e; e++) {
        if (strncmp(*e, "LD_PRELOAD=", 11) == 0)
            continue;
        if (strncmp(*e, "LD_LIBRARY_PATH=", 16) == 0)
            continue;
        if (strncmp(*e, "SHELLY_GLIBC_LD_LIBRARY_PATH=", 29) == 0) {
            fwd_libpath = *e + 29;
            continue;
        }
        child_envp[ce++] = *e;
    }
    char *libpath_entry = NULL;
    if (fwd_libpath && fwd_libpath[0]) {
        size_t len = 16 + strlen(fwd_libpath) + 1;
        libpath_entry = malloc(len);
        if (!libpath_entry)
            die("out of memory for LD_LIBRARY_PATH");
        snprintf(libpath_entry, len, "LD_LIBRARY_PATH=%s", fwd_libpath);
        child_envp[ce++] = libpath_entry;
    }
    child_envp[ce] = NULL;

    /* Snapshot the real auxv for hardware/system values. */
    auxpair_t real_av[64];
    size_t real_n = read_real_auxv(real_av, 64);

    /* 16 fresh random bytes for AT_RANDOM. getentropy is available on
     * bionic; fall back to AT_RANDOM copied from the real auxv, else time. */
    static uint8_t at_random[16];
    if (getentropy(at_random, sizeof(at_random)) != 0) {
        uint64_t r = find_real_aux(real_av, real_n, AT_RANDOM, 0);
        if (r)
            memcpy(at_random, (void *)(uintptr_t)r, sizeof(at_random));
        else {
            uint64_t seed = (uint64_t)getpid() ^ (uint64_t)(uintptr_t)&at_random;
            memcpy(at_random, &seed, sizeof(seed));
            memcpy(at_random + 8, &seed, sizeof(seed));
        }
    }

    static const char at_platform[] = "aarch64";

    /*
     * The initial stack must have, from low to high:
     *   argc
     *   argv[0..child_argc-1], NULL
     *   envp[0..ce-1], NULL
     *   auxv pairs, AT_NULL pair
     * The string data (argv/envp strings, AT_RANDOM, AT_PLATFORM, AT_EXECFN)
     * is already in memory elsewhere (environ strings, our statics); we can
     * point auxv/argv at those existing addresses. argv/envp string contents
     * are the original pointers, which remain valid (we abandon bionic but
     * never free its data). So we only need to lay out the pointer arrays +
     * aux array; no string copying required.
     */

    /* Count auxv entries we will emit. */
    enum { MAX_AUX = 24 };
    auxpair_t aux[MAX_AUX];
    size_t na = 0;
#define PUT_AUX(t, v) do { if (na >= MAX_AUX) die("auxv overflow"); aux[na].a_type = (t); aux[na].a_val = (uint64_t)(v); na++; } while (0)

    PUT_AUX(AT_PHDR, ld.phdr);
    PUT_AUX(AT_PHENT, ld.phentsize);
    PUT_AUX(AT_PHNUM, ld.phnum);
    PUT_AUX(AT_BASE, 0);                 /* ld.so is the program; no separate interp base */
    PUT_AUX(AT_ENTRY, ld.entry);
    PUT_AUX(AT_PAGESZ, g_pagesz);
    PUT_AUX(AT_FLAGS, 0);
    PUT_AUX(AT_RANDOM, (uintptr_t)at_random);
    PUT_AUX(AT_PLATFORM, (uintptr_t)at_platform);
    PUT_AUX(AT_UID, getuid());
    PUT_AUX(AT_EUID, geteuid());
    PUT_AUX(AT_GID, getgid());
    PUT_AUX(AT_EGID, getegid());
    PUT_AUX(AT_SECURE, 0);
    PUT_AUX(AT_EXECFN, (uintptr_t)child_argv[0]);
    PUT_AUX(AT_HWCAP, find_real_aux(real_av, real_n, AT_HWCAP, 0));
    PUT_AUX(AT_HWCAP2, find_real_aux(real_av, real_n, AT_HWCAP2, 0));
    PUT_AUX(AT_CLKTCK, find_real_aux(real_av, real_n, AT_CLKTCK, 100));
    {
        uint64_t ehdr = find_real_aux(real_av, real_n, AT_SYSINFO_EHDR, 0);
        if (ehdr)
            PUT_AUX(AT_SYSINFO_EHDR, ehdr);
    }
#ifdef AT_MINSIGSTKSZ
    {
        uint64_t mss = find_real_aux(real_av, real_n, AT_MINSIGSTKSZ, 0);
        if (mss)
            PUT_AUX(AT_MINSIGSTKSZ, mss);
    }
#endif
    PUT_AUX(AT_NULL, 0);
#undef PUT_AUX

    /*
     * Allocate a dedicated stack for the glibc world. glibc's ld.so reads its
     * own stack for argc/argv/envp/auxv; it does NOT require this to be the
     * "real" process stack. 8 MiB with a guard page below.
     */
    size_t stack_size = 8 * 1024 * 1024;
    uint8_t *stack = mmap(NULL, stack_size, PROT_READ | PROT_WRITE,
                          MAP_PRIVATE | MAP_ANONYMOUS | MAP_STACK, -1, 0);
    if (stack == MAP_FAILED)
        die("stack mmap: %s", strerror(errno));

    /*
     * Compute the number of 8-byte words the kernel-style block needs:
     *   1 (argc) + (child_argc + 1) argv + (ce + 1) envp + na*2 aux words.
     * The whole block must leave sp 16-byte aligned at argc. We place the
     * block at the top of the stack region.
     */
    size_t words = 1                      /* argc */
                 + (size_t)child_argc + 1 /* argv + NULL */
                 + ce + 1                 /* envp + NULL */
                 + na * 2;                /* aux pairs incl AT_NULL */

    uintptr_t top = (uintptr_t)stack + stack_size;
    uintptr_t sp = top - words * sizeof(uint64_t);
    sp &= ~(uintptr_t)0xF; /* 16-byte align the argc slot */

    uint64_t *p = (uint64_t *)sp;
    *p++ = (uint64_t)child_argc;
    for (int i = 0; i < child_argc; i++)
        *p++ = (uint64_t)(uintptr_t)child_argv[i];
    *p++ = 0; /* argv NULL terminator */
    for (size_t i = 0; i < ce; i++)
        *p++ = (uint64_t)(uintptr_t)child_envp[i];
    *p++ = 0; /* envp NULL terminator */
    for (size_t i = 0; i < na; i++) {
        *p++ = aux[i].a_type;
        *p++ = aux[i].a_val;
    }

    /*
     * Reset signal state bionic installed (debuggerd handlers etc.) so glibc
     * starts from a clean slate: all handlers to SIG_DFL, empty signal mask.
     */
    for (int sig = 1; sig < NSIG; sig++) {
        struct sigaction sa;
        memset(&sa, 0, sizeof(sa));
        sa.sa_handler = SIG_DFL;
        sigaction(sig, &sa, NULL); /* ignore failures on SIGKILL/SIGSTOP */
    }
    sigset_t empty;
    sigemptyset(&empty);
    sigprocmask(SIG_SETMASK, &empty, NULL);

    fflush(NULL);

    /* Hand off to ld.so. Never returns. */
    shelly_glibc_trampoline((void *)sp, ld.entry);
    die("trampoline returned");
}

/*
 * The trampoline sets sp to the kernel-style stack block and jumps to ld.so's
 * entry with x0 = 0 (no rtld_fini supplied; glibc tolerates a NULL here), the
 * AArch64 SysV convention for a freshly-exec'd program. After `mov sp` we must
 * not touch the old stack through the C ABI, so we jump immediately and never
 * return. Not a naked function: we take `sp`/`entry` as explicit asm inputs so
 * -Wunused-parameter cannot fire, and the compiler's own prologue has already
 * run (and is harmless) before we switch stacks.
 */
void shelly_glibc_trampoline(void *sp, uintptr_t entry) {
    register uintptr_t x_sp __asm__("x9") = (uintptr_t)sp;
    register uintptr_t x_entry __asm__("x10") = entry;
    __asm__ volatile(
        "mov sp, %0\n"   /* sp = freshly built stack (argc at [sp]) */
        "mov x30, xzr\n" /* clear link register */
        "mov x0, xzr\n"  /* rtld_fini = NULL */
        "br %1\n"        /* jump to ld.so entry */
        :
        : "r"(x_sp), "r"(x_entry)
        : "memory", "x0", "x30");
    __builtin_unreachable();
}

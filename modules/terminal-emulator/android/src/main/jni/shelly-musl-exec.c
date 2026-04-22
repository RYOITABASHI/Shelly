#define _GNU_SOURCE

#include <elf.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef PAGE_ALIGN_DOWN
#define PAGE_ALIGN_DOWN(x, p) ((x) & ~((uintptr_t)((p)-1)))
#endif
#ifndef PAGE_ALIGN_UP
#define PAGE_ALIGN_UP(x, p) (((x) + ((uintptr_t)(p)-1)) & ~((uintptr_t)((p)-1)))
#endif
#ifndef MAP_STACK
#define MAP_STACK 0
#endif

#define STACK_SIZE (2 * 1024 * 1024)
#define RANDOM_SIZE 16

static void die_errno(const char *msg) {
  fprintf(stderr, "shelly-musl-exec: %s: %s\n", msg, strerror(errno));
  _exit(127);
}

static void die_msg(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  fprintf(stderr, "shelly-musl-exec: ");
  vfprintf(stderr, fmt, ap);
  fprintf(stderr, "\n");
  va_end(ap);
  _exit(127);
}

static uint8_t *stack_alloc_bytes(uint8_t **sp, const void *src, size_t n,
                                  size_t align) {
  uintptr_t p = (uintptr_t)(*sp);
  p -= n;
  p &= ~((uintptr_t)align - 1);
  memcpy((void *)p, src, n);
  *sp = (uint8_t *)p;
  return (uint8_t *)p;
}

static char *stack_strdup(uint8_t **sp, const char *s) {
  size_t n = strlen(s) + 1;
  return (char *)stack_alloc_bytes(sp, s, n, 1);
}

struct loaded_elf {
  uintptr_t load_bias;
  uintptr_t entry;
  uintptr_t phdr_addr;
  uint16_t phent;
  uint16_t phnum;
};

static int phdr_prot(uint32_t flags) {
  int prot = 0;
  if (flags & PF_R) prot |= PROT_READ;
  if (flags & PF_W) prot |= PROT_WRITE;
  if (flags & PF_X) prot |= PROT_EXEC;
  return prot;
}

static void zero_range_with_prot(uintptr_t start, uintptr_t end, int prot, long page_size) {
  if (end <= start) return;
  uintptr_t page_start = PAGE_ALIGN_DOWN(start, page_size);
  uintptr_t page_end = PAGE_ALIGN_UP(end, page_size);
  size_t span = (size_t)(page_end - page_start);
  bool need_restore = (prot & PROT_WRITE) == 0;
  if (need_restore) {
    if (mprotect((void *)page_start, span, prot | PROT_WRITE) != 0) {
      die_errno("mprotect add write for bss tail failed");
    }
  }
  memset((void *)start, 0, (size_t)(end - start));
  if (need_restore) {
    if (mprotect((void *)page_start, span, prot) != 0) {
      die_errno("mprotect restore prot for bss tail failed");
    }
  }
}

static struct loaded_elf map_elf_load_segments(const char *path, long page_size) {
  struct loaded_elf out = {0};
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) die_errno("open ld-musl failed");

  struct stat st;
  if (fstat(fd, &st) != 0) die_errno("fstat ld-musl failed");
  if (st.st_size < (off_t)sizeof(Elf64_Ehdr)) die_msg("ld-musl too small: %s", path);

  void *file_map = mmap(NULL, (size_t)st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
  if (file_map == MAP_FAILED) die_errno("mmap ld-musl file failed");

  const Elf64_Ehdr *eh = (const Elf64_Ehdr *)file_map;
  if (memcmp(eh->e_ident, ELFMAG, SELFMAG) != 0) die_msg("not an ELF: %s", path);
  if (eh->e_ident[EI_CLASS] != ELFCLASS64) die_msg("ELF class is not 64-bit: %s", path);
  if (eh->e_ident[EI_DATA] != ELFDATA2LSB) die_msg("ELF endianness is not little-endian: %s", path);
  if (eh->e_machine != EM_AARCH64) die_msg("ELF machine is not AArch64: %s", path);
  if (eh->e_type != ET_DYN) die_msg("ld-musl must be ET_DYN, got e_type=%u", eh->e_type);
  if (eh->e_phnum == 0) die_msg("no program headers in %s", path);
  if (eh->e_phentsize != sizeof(Elf64_Phdr)) {
    die_msg("unexpected e_phentsize=%u (expected %zu)", eh->e_phentsize, sizeof(Elf64_Phdr));
  }

  if (eh->e_phoff + (uint64_t)eh->e_phnum * sizeof(Elf64_Phdr) > (uint64_t)st.st_size) {
    die_msg("program headers out of range in %s", path);
  }

  const Elf64_Phdr *ph = (const Elf64_Phdr *)((const uint8_t *)file_map + eh->e_phoff);

  uintptr_t min_vaddr = UINTPTR_MAX;
  uintptr_t max_vaddr = 0;
  bool saw_load = false;
  for (uint16_t i = 0; i < eh->e_phnum; i++) {
    if (ph[i].p_type != PT_LOAD) continue;
    if (ph[i].p_memsz == 0) continue;
    uintptr_t seg_start = PAGE_ALIGN_DOWN((uintptr_t)ph[i].p_vaddr, page_size);
    uintptr_t seg_end = PAGE_ALIGN_UP((uintptr_t)ph[i].p_vaddr + (uintptr_t)ph[i].p_memsz, page_size);
    if (!saw_load || seg_start < min_vaddr) min_vaddr = seg_start;
    if (!saw_load || seg_end > max_vaddr) max_vaddr = seg_end;
    saw_load = true;
  }
  if (!saw_load || min_vaddr >= max_vaddr) die_msg("no valid PT_LOAD segments in %s", path);

  size_t total_map_len = (size_t)(max_vaddr - min_vaddr);
  void *reserved = mmap(NULL, total_map_len, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (reserved == MAP_FAILED) die_errno("reserve virtual range failed");

  uintptr_t load_bias = (uintptr_t)reserved - min_vaddr;

  for (uint16_t i = 0; i < eh->e_phnum; i++) {
    if (ph[i].p_type != PT_LOAD || ph[i].p_memsz == 0) continue;

    uintptr_t seg_page_start = PAGE_ALIGN_DOWN(load_bias + (uintptr_t)ph[i].p_vaddr, page_size);
    uintptr_t seg_page_end_file = PAGE_ALIGN_UP(load_bias + (uintptr_t)ph[i].p_vaddr + (uintptr_t)ph[i].p_filesz, page_size);
    uintptr_t seg_page_end_mem = PAGE_ALIGN_UP(load_bias + (uintptr_t)ph[i].p_vaddr + (uintptr_t)ph[i].p_memsz, page_size);
    off_t file_off_page = (off_t)PAGE_ALIGN_DOWN((uintptr_t)ph[i].p_offset, page_size);

    int prot = phdr_prot(ph[i].p_flags);

    if (seg_page_end_file > seg_page_start) {
      void *mapped = mmap((void *)seg_page_start,
                          (size_t)(seg_page_end_file - seg_page_start),
                          prot,
                          MAP_PRIVATE | MAP_FIXED,
                          fd,
                          file_off_page);
      if (mapped == MAP_FAILED) die_errno("mmap PT_LOAD file pages failed");
    }

    uintptr_t seg_data_end = load_bias + (uintptr_t)ph[i].p_vaddr + (uintptr_t)ph[i].p_filesz;
    uintptr_t seg_mem_end = load_bias + (uintptr_t)ph[i].p_vaddr + (uintptr_t)ph[i].p_memsz;

    if (seg_mem_end > seg_data_end) {
      uintptr_t tail_end = seg_page_end_file < seg_mem_end ? seg_page_end_file : seg_mem_end;
      if (tail_end > seg_data_end) {
        zero_range_with_prot(seg_data_end, tail_end, prot, page_size);
      }
      if (seg_page_end_mem > seg_page_end_file) {
        void *anon = mmap((void *)seg_page_end_file,
                          (size_t)(seg_page_end_mem - seg_page_end_file),
                          prot,
                          MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED,
                          -1,
                          0);
        if (anon == MAP_FAILED) die_errno("mmap PT_LOAD bss pages failed");
      }
    }
  }

  out.load_bias = load_bias;
  out.entry = load_bias + (uintptr_t)eh->e_entry;
  out.phdr_addr = load_bias + (uintptr_t)eh->e_phoff;
  out.phent = eh->e_phentsize;
  out.phnum = eh->e_phnum;

  munmap(file_map, (size_t)st.st_size);
  close(fd);
  return out;
}

static size_t count_env(char *const envp[]) {
  size_t n = 0;
  while (envp[n] != NULL) n++;
  return n;
}

static Elf64_auxv_t *find_auxv(char *const envp[]) {
  size_t envc = count_env(envp);
  return (Elf64_auxv_t *)&envp[envc + 1];
}

static size_t count_auxv(const Elf64_auxv_t *auxv) {
  size_t n = 0;
  while (auxv[n].a_type != AT_NULL) n++;
  return n + 1;
}

static unsigned long aux_get(const Elf64_auxv_t *auxv, size_t auxc, unsigned long key) {
  for (size_t i = 0; i < auxc; i++) {
    if (auxv[i].a_type == key) return auxv[i].a_un.a_val;
  }
  return 0;
}

static void aux_set(Elf64_auxv_t *auxv, size_t auxc, unsigned long key, unsigned long val) {
  for (size_t i = 0; i < auxc; i++) {
    if (auxv[i].a_type == key) {
      auxv[i].a_un.a_val = val;
      return;
    }
  }
  die_msg("auxv missing required key %lu", key);
}

static size_t aux_upsert(Elf64_auxv_t *auxv, size_t auxc, size_t cap,
                         unsigned long key, unsigned long val) {
  for (size_t i = 0; i < auxc; i++) {
    if (auxv[i].a_type == key) {
      auxv[i].a_un.a_val = val;
      return auxc;
    }
  }
  if (auxc + 1 >= cap) {
    die_msg("auxv capacity exceeded while adding key %lu", key);
  }
  size_t null_idx = auxc - 1;
  auxv[null_idx].a_type = key;
  auxv[null_idx].a_un.a_val = val;
  auxv[null_idx + 1].a_type = AT_NULL;
  auxv[null_idx + 1].a_un.a_val = 0;
  return auxc + 1;
}

__attribute__((noreturn))
static void jump_to_entry(uintptr_t entry, uintptr_t new_sp) {
#if defined(__aarch64__)
  __asm__ volatile(
      "mov sp, %0\n"
      "br %1\n"
      :
      : "r"(new_sp), "r"(entry)
      : "memory");
  __builtin_unreachable();
#else
  (void)entry;
  (void)new_sp;
  die_msg("shelly-musl-exec currently supports only aarch64 runtime");
#endif
}

int main(int argc, char *argv[], char *envp[]) {
  if (argc < 3) {
    fprintf(stderr, "usage: %s /path/to/ld-musl /path/to/target [args...]\n", argv[0]);
    return 2;
  }

  const char *ld_path = argv[1];
  long page_size = sysconf(_SC_PAGESIZE);
  if (page_size <= 0) die_msg("failed to query page size");

  struct loaded_elf ld = map_elf_load_segments(ld_path, page_size);

  void *stack = mmap(NULL, STACK_SIZE, PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANONYMOUS | MAP_STACK, -1, 0);
  if (stack == MAP_FAILED) die_errno("mmap stack failed");

  uint8_t *sp = (uint8_t *)stack + STACK_SIZE;
  sp = (uint8_t *)((uintptr_t)sp & ~((uintptr_t)0xf));

  size_t new_argc = (size_t)(argc - 1);
  char **new_argv = calloc(new_argc, sizeof(char *));
  if (!new_argv) die_errno("calloc new_argv failed");

  for (size_t i = 0; i < new_argc; i++) {
    new_argv[i] = stack_strdup(&sp, argv[i + 1]);
  }

  size_t envc = count_env(envp);
  char **new_env = calloc(envc, sizeof(char *));
  if (!new_env) die_errno("calloc new_env failed");
  size_t new_envc = 0;
  for (size_t i = 0; i < envc; i++) {
    /* The parent PTY preloads a bionic exec wrapper so normal bionic tools
     * can spawn app-data binaries through linker64. musl cannot relocate
     * that bionic .so, so never propagate it into the musl loader. */
    if (strncmp(envp[i], "LD_PRELOAD=", 11) == 0) continue;
    new_env[new_envc++] = stack_strdup(&sp, envp[i]);
  }

  Elf64_auxv_t *old_auxv = find_auxv(envp);
  size_t auxc = count_auxv(old_auxv);
  size_t aux_cap = auxc + 8;
  Elf64_auxv_t *new_auxv = calloc(aux_cap, sizeof(Elf64_auxv_t));
  if (!new_auxv) die_errno("calloc new_auxv failed");
  memcpy(new_auxv, old_auxv, auxc * sizeof(Elf64_auxv_t));

  uint8_t random_bytes[RANDOM_SIZE];
  ssize_t got = getrandom(random_bytes, sizeof(random_bytes), 0);
  if (got != (ssize_t)sizeof(random_bytes)) {
    unsigned long old_rand = aux_get(old_auxv, auxc, AT_RANDOM);
    if (old_rand == 0) die_msg("AT_RANDOM missing and getrandom failed");
    memcpy(random_bytes, (const void *)old_rand, sizeof(random_bytes));
  }
  uint8_t *random_on_stack = stack_alloc_bytes(&sp, random_bytes, sizeof(random_bytes), 16);

  aux_set(new_auxv, auxc, AT_PHDR, (unsigned long)ld.phdr_addr);
  aux_set(new_auxv, auxc, AT_PHENT, (unsigned long)ld.phent);
  aux_set(new_auxv, auxc, AT_PHNUM, (unsigned long)ld.phnum);
  aux_set(new_auxv, auxc, AT_BASE, 0UL);
  aux_set(new_auxv, auxc, AT_ENTRY, (unsigned long)ld.entry);
  aux_set(new_auxv, auxc, AT_PAGESZ, (unsigned long)page_size);
  auxc = aux_upsert(new_auxv, auxc, aux_cap, AT_EXECFN, (unsigned long)new_argv[0]);
  aux_set(new_auxv, auxc, AT_RANDOM, (unsigned long)random_on_stack);

  size_t ptr_count = 1 + (new_argc + 1) + (new_envc + 1);
  size_t words_for_auxv = auxc * 2;
  size_t total_words = ptr_count + words_for_auxv;

  sp -= total_words * sizeof(uintptr_t);
  sp = (uint8_t *)((uintptr_t)sp & ~((uintptr_t)0xf));
  uintptr_t *w = (uintptr_t *)sp;

  size_t k = 0;
  w[k++] = (uintptr_t)new_argc;
  for (size_t i = 0; i < new_argc; i++) w[k++] = (uintptr_t)new_argv[i];
  w[k++] = 0;
  for (size_t i = 0; i < new_envc; i++) w[k++] = (uintptr_t)new_env[i];
  w[k++] = 0;
  for (size_t i = 0; i < auxc; i++) {
    w[k++] = (uintptr_t)new_auxv[i].a_type;
    w[k++] = (uintptr_t)new_auxv[i].a_un.a_val;
  }

  jump_to_entry(ld.entry, (uintptr_t)sp);
}

cmake_minimum_required(VERSION 3.18.1)
project(termux)

add_library(termux SHARED src/main/jni/termux.c)
target_link_libraries(termux log)

add_library(shelly-pty SHARED src/main/jni/shelly-pty.c)
target_link_libraries(shelly-pty log)

add_library(shelly-exec SHARED src/main/jni/shelly-exec.c)
target_link_libraries(shelly-exec log)

# LD_PRELOAD library: intercepts execve() to redirect through linker64
# on Android 10+ where SELinux blocks direct execution from app_data_file
add_library(exec_wrapper SHARED src/main/jni/exec-wrapper.c)
target_link_libraries(exec_wrapper dl log)
# v75-followup (2026-05-06): force eager (BIND_NOW) PLT resolution so
# this LD_PRELOAD shim never branches into an unresolved trampoline at
# runtime. CI cache hits had been masking a layout regression where the
# rebuilt .so left a lazy-resolved __android_log_print PLT slot pointing
# at an unmapped page — every fresh build crashed bash startup with
# SIGSEGV at PC=0x1ff0 (the "stub address" sentinel) on the first
# LOGI call inside execve. -Wl,-z,now resolves all PLT entries when the
# library loads so the trampoline is no longer in scope. Same flag also
# forces RELRO (safer for an LD_PRELOAD shim that other processes load
# under their own dynamic linker).
target_link_options(exec_wrapper PRIVATE "-Wl,-z,now" "-Wl,-z,relro")

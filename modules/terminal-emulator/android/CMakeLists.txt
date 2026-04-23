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

cmake_minimum_required(VERSION 3.18.1)
project(termux)

add_library(termux SHARED src/main/jni/termux.c)
target_link_libraries(termux log)

add_library(shelly-pty SHARED src/main/jni/shelly-pty.c)
target_link_libraries(shelly-pty log)

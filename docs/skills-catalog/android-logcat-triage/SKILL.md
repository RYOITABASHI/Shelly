---
name: android-logcat-triage
description: Systematically narrow down an Android app bug using adb logcat instead of guessing from the crash screenshot alone.
---
When investigating an Android app bug (crash, hang, wrong behavior) that
has an adb-connected device or emulator available, work outward from the
narrowest useful signal instead of dumping the entire unfiltered log:

1. **Reproduce with a tag filter already narrowed**, if the app has known
   debug tags (check the project's docs/CLAUDE.md for a tag table). Start
   the filtered capture *before* reproducing, not after:
   `adb logcat -c` (clear old buffer) then `adb logcat -s <TAG1>:* <TAG2>:*`.
2. **If no tag is known yet**, reproduce once with `adb logcat *:E` (errors
   only) to find the crashing component/exception, then re-run with that
   component's tag to see the surrounding context.
3. **For a crash/ANR specifically**, get the full stack trace in one shot:
   `adb logcat -b crash -d` (crash buffer, dump-and-exit) or
   `adb shell dumpsys activity ondestroy for an ANR`, rather than scrolling
   a live-scrolling terminal.
4. **Correlate timestamps**, not just tags — note the wall-clock time the
   bug was observed on-device, then grep the log around that timestamp;
   a relevant line can be emitted by a tag you didn't think to filter for.
5. **Check permission/state transitions separately from the crash itself**
   when the symptom smells like a permissions or lifecycle issue (e.g.
   `dumpsys package <pkg> | grep permission`, `dumpsys activity | grep -A5
   <pkg>`) — many "random" Android bugs are actually a permission silently
   denied or a component in the wrong lifecycle state, which won't show up
   as a stack trace at all.
6. **Summarize the causal chain before proposing a fix**: which log line
   is the root cause vs. a downstream symptom, and what specific code path
   produced it — don't jump straight to a patch from a single Exception
   line without confirming what triggered it.

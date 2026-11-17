/**
 * lib/agent-chain-lock-protocol.ts — the chain-lock protocol for
 * `locks/<id>.chain.lock` as POSIX shell, shared byte for byte with the APK
 * asset modules/terminal-emulator/android/src/main/assets/shelly-chain-lock.sh
 * (AgentRuntime.clearStaleChainLock runs the asset through /system/bin/sh;
 * __tests__/agent-chain-lock-protocol.test.ts pins the two equal and runs the
 * protocol on a real filesystem). The header of the script states the
 * invariants. Every JS chain-lock command (acquire, check, release, disarm,
 * and the discard when an agent is deleted)
 * is this library followed by one function call.
 */
export const CHAIN_LOCK_SHELL = `# shelly-chain-lock.sh: the one protocol for locks/<id>.chain.lock, shared
# byte for byte by lib/agent-chain-lock-protocol.ts (JS acquire / check /
# release / disarm / discard, through runCommand) and this APK asset
# (AgentRuntime's pre-launch stale cleanup, through /system/bin/sh). POSIX
# sh: sourced, then one shelly_chain_lock_* function is called.
#
# Instance binding: each operation runs in a subshell whose working
# directory is the lock directory itself (cd -P), so its reads, its stale
# test and its marker all apply to the one instance that was at the path
# when it entered, even if the path is replaced meanwhile.
#
# Removal: an instance is removed only by the holder of its "reaping"
# marker (mkdir inside the bound instance; exactly one caller succeeds).
# Stale reaping, owner release and deleting the agent all take it; nothing
# else removes a chain lock. While the marker is held the path therefore
# still names that instance: it is renamed to a unique tomb, the rename is
# checked by inode (test -ef), and only then deleted.
#
# Marker holder: the marker records the holder's pid and kernel start time.
# A marker whose holder is gone (killed between taking it and removing the
# lock) is taken over through an exclusive nested marker (reaping/takeover,
# nesting as deep as needed), so an interrupted cleanup never strands a stale
# lock. A live holder (also a frozen one) is never taken over: a holder
# checks for a takeover after publishing its record, a taker re-checks the
# holder after creating its takeover (see shelly_cl_take_marker). A marker
# without a holder record counts as gone only once it is STALE seconds old.
#
# Stale (CHAIN_LOCK_STALE_MS): acquired-at (epoch seconds; anything but
# digits reads as 0) is at least STALE seconds old AND the directory's own
# mtime is at least STALE seconds old (unless it already carries a marker,
# see the reap). A lock created a moment ago, whose metadata is not written
# yet, has a fresh mtime and no marker, and is never stale.
#
# Every unexpected outcome reports the lock as held.

shelly_cl_hook() { :; }

shelly_cl_digits() {
  case "$1" in ''|*[!0-9]*) echo 0 ;; *) echo "$1" ;; esac
}

# Sets shelly_cl_pst_out to "pid starttime" of /proc/$1 ("self" = the
# calling shell process: the redirection is opened by the shell itself, so
# never call this inside $(...), which would read a short-lived fork).
shelly_cl_pst() {
  shelly_cl_pst_out=
  shelly_cl_line=
  read -r shelly_cl_line 2>/dev/null < "/proc/$1/stat" || return 1
  # Field 2 (comm) of a shell has no spaces.
  set -- $shelly_cl_line
  [ $# -ge 22 ] || return 1
  shelly_cl_pid=$1
  shift 21
  shelly_cl_pst_out="$shelly_cl_pid $1"
}

# 0 when the "pid starttime" record $1 names a process that is still running.
shelly_cl_alive() {
  set -- $1
  [ -n "$1" ] && [ -n "$2" ] || return 1
  shelly_cl_pst "$1" || return 1
  [ "$shelly_cl_pst_out" = "$1 $2" ]
}

# 0 when the holder of marker $1 is gone: its record names a process that
# is no longer running, or it has no record and is at least STALE ($3)
# seconds old (now $2).
shelly_cl_holder_gone() {
  shelly_cl_owner=$(cat "$1/owner" 2>/dev/null)
  if [ -n "$shelly_cl_owner" ]; then
    shelly_cl_alive "$shelly_cl_owner" && return 1
    return 0
  fi
  shelly_cl_mm=$(shelly_cl_digits "$(stat -c %Y "$1" 2>/dev/null)")
  [ "$shelly_cl_mm" -gt 0 ] && [ $(( $2 - shelly_cl_mm )) -ge "$3" ]
}

# In the bound instance: take its marker. $1 now, $2 STALE.
# 0 = held (path in shelly_cl_marker); non-zero = not held.
# A holder publishes its record and THEN looks for a takeover of its
# marker; a taker creates the takeover and THEN looks at the holder's record
# again. Each side writes before it reads, so at least one sees the other:
# never both proceed (if both see each other both yield, and the next
# cleanup decides once the holder has exited). Levels nest without limit
# (only a dead holder's marker is ever entered).
shelly_cl_take_marker() {
  shelly_cl_marker=./reaping
  shelly_cl_parent=
  while ! mkdir "$shelly_cl_marker" 2>/dev/null; do
    [ -d "$shelly_cl_marker" ] || return 1
    shelly_cl_holder_gone "$shelly_cl_marker" "$1" "$2" || return 1
    shelly_cl_parent=$shelly_cl_marker
    shelly_cl_marker="$shelly_cl_marker/takeover"
  done
  if ! shelly_cl_pst self || ! printf '%s' "$shelly_cl_pst_out" > "$shelly_cl_marker/owner"; then
    shelly_cl_drop_marker
    return 1
  fi
  shelly_cl_hook published
  # Someone took this marker over before the record was out: yield (the
  # record stays and names this process, gone once it exits).
  [ -e "$shelly_cl_marker/takeover" ] && return 1
  # A takeover: the holder it replaces must still be gone now. (Its age was
  # established before; creating the takeover refreshed that marker's mtime,
  # so only a record that appeared meanwhile can change the answer.)
  if [ -n "$shelly_cl_parent" ]; then
    shelly_cl_owner=$(cat "$shelly_cl_parent/owner" 2>/dev/null)
    if [ -n "$shelly_cl_owner" ] && shelly_cl_alive "$shelly_cl_owner"; then
      shelly_cl_drop_marker
      return 1
    fi
  fi
  return 0
}

# In the bound instance, marker held: give it back (nothing removed).
shelly_cl_drop_marker() {
  rm -f "$shelly_cl_marker/owner" 2>/dev/null
  rmdir "$shelly_cl_marker" 2>/dev/null
}

# In the bound instance, marker held: $1 lock dir, $2 tomb suffix.
# 0 = that instance was moved away and deleted; non-zero = nothing removed.
shelly_cl_remove_bound() {
  shelly_cl_tomb="$1.$2"
  [ -e "$shelly_cl_tomb" ] && return 1
  [ . -ef "$1" ] || return 1
  shelly_cl_hook pre-move
  mv "$1" "$shelly_cl_tomb" 2>/dev/null || return 1
  if [ . -ef "$shelly_cl_tomb" ]; then
    cd / && rm -rf "$shelly_cl_tomb"
    return 0
  fi
  # Only a remover outside this protocol (a user's own shell) can get here:
  # put back what was moved unless the path was taken meanwhile.
  [ -e "$1" ] || mv "$shelly_cl_tomb" "$1" 2>/dev/null
  return 2
}

# $1 lock dir, $2 now (epoch s), $3 STALE (s).
# Prints REAPED (that stale instance was removed), ABSENT or LOCKED.
shelly_chain_lock_reap() (
  cd -P "$1" 2>/dev/null || { if [ -e "$1" ]; then echo LOCKED; else echo ABSENT; fi; exit 0; }
  shelly_cl_hook bound
  shelly_cl_at=$(shelly_cl_digits "$(cat ./acquired-at 2>/dev/null)")
  if [ $(( $2 - shelly_cl_at )) -lt "$3" ]; then echo LOCKED; exit 0; fi
  # Newborn guard. Skipped when a marker is already there: taking a marker
  # refreshes the mtime, and a lock carries one only after a cleanup judged
  # it stale (or while its owner / an agent deletion removes it).
  if [ ! -d ./reaping ]; then
    shelly_cl_mt=$(shelly_cl_digits "$(stat -c %Y . 2>/dev/null)")
    if [ "$shelly_cl_mt" -le 0 ] || [ $(( $2 - shelly_cl_mt )) -lt "$3" ]; then echo LOCKED; exit 0; fi
  fi
  shelly_cl_hook validated
  shelly_cl_take_marker "$2" "$3" || { echo LOCKED; exit 0; }
  shelly_cl_hook marked
  if shelly_cl_remove_bound "$1" "reaped-$$-$2"; then echo REAPED; exit 0; fi
  shelly_cl_drop_marker
  echo LOCKED
)

# $1 lock dir, $2 seed, $3 now. 0 = created with its metadata; 1 = the path
# exists; 2 = created but its metadata could not be written (left in place:
# its fresh mtime protects it, it turns stale like any other lock).
shelly_cl_create() {
  mkdir "$1" 2>/dev/null || return 1
  # Just created: no reaper takes it (fresh mtime) and no owner release
  # matches it (no seed yet), so the path still names it here.
  ( cd -P "$1" && printf '%s' "$2" > ./seed && printf '' > ./token && printf '%s' "$3" > ./acquired-at ) 2>/dev/null || return 2
  return 0
}

# $1 lock dir, $2 seed, $3 now, $4 STALE. Prints CHAIN_LOCK_OK or CHAIN_LOCK_BUSY
# (the output is the result; the status is 0 either way).
shelly_chain_lock_acquire() {
  shelly_cl_create "$1" "$2" "$3"
  case $? in
    0) echo CHAIN_LOCK_OK; return 0 ;;
    2) echo CHAIN_LOCK_BUSY; return 0 ;;
  esac
  case "$(shelly_chain_lock_reap "$1" "$3" "$4")" in
    REAPED|ABSENT)
      if shelly_cl_create "$1" "$2" "$3"; then echo CHAIN_LOCK_OK; return 0; fi
      ;;
  esac
  echo CHAIN_LOCK_BUSY
}

# $1 lock dir, $2 now, $3 STALE. Prints CHAIN_LOCK_BUSY unless no lock remains.
shelly_chain_lock_check() {
  [ -e "$1" ] || return 0
  case "$(shelly_chain_lock_reap "$1" "$2" "$3")" in
    REAPED|ABSENT) return 0 ;;
  esac
  echo CHAIN_LOCK_BUSY
}

# $1 lock dir, $2 owner seed, $3 now, $4 STALE. Removes the lock only if the
# instance there holds that seed; prints RELEASED when it did.
shelly_chain_lock_release() (
  [ -n "$2" ] || exit 0
  cd -P "$1" 2>/dev/null || exit 0
  [ "$(cat ./seed 2>/dev/null)" = "$2" ] || exit 0
  # A live holder of the marker: this lock went stale and is being removed.
  shelly_cl_take_marker "$3" "$4" || exit 0
  if shelly_cl_remove_bound "$1" "released-$$"; then echo RELEASED; exit 0; fi
  shelly_cl_drop_marker
  exit 0
)

# $1 lock dir, $2 owner seed. Clears the live token only in the instance
# holding that seed.
shelly_chain_lock_disarm() (
  [ -n "$2" ] || exit 0
  cd -P "$1" 2>/dev/null || exit 0
  if [ "$(cat ./seed 2>/dev/null)" = "$2" ]; then printf '' > ./token; fi
  exit 0
)

# Deleting the agent: $1 lock dir, $2 now, $3 STALE. Removes whatever
# instance is there, but still under its marker (a live holder is already
# removing it). Prints DISCARDED, ABSENT or LOCKED; status 0.
shelly_chain_lock_discard() (
  cd -P "$1" 2>/dev/null || { if [ -e "$1" ]; then echo LOCKED; else echo ABSENT; fi; exit 0; }
  shelly_cl_take_marker "$2" "$3" || { echo LOCKED; exit 0; }
  if shelly_cl_remove_bound "$1" "discarded-$$"; then echo DISCARDED; exit 0; fi
  shelly_cl_drop_marker
  echo LOCKED
)
`;

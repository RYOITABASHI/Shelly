# Codex remote control on Shelly — socket root problem and proposed upstream fix

Date: 2026-10-13 · Branch: `feat/codex-remote-control` · Status: Experimental, on-device unverified

## Goal

Let Shelly act as a host for "Codex in the ChatGPT mobile app" remote control using only the
official Codex CLI feature `codex remote-control` (no reverse engineering). The host connects
outbound over HTTPS/WSS to `chatgpt_base_url` (`wham/remote/control/server/{enroll,pair,pair/status}`)
and requires a ChatGPT login (API-key auth is unsupported).

## Findings (codex-termux `v0.162.1-termux.1`, upstream `rust-v0.162.1`)

1. `codex remote-control` (bare) runs a daemon unless `--no-daemon`, `--json`, root `-c` overrides,
   or a disabled `DaemonAutoStart` feature make it ineligible; then it runs an embedded app-server in
   the foreground (`codex-rs/cli/src/remote_control_cmd.rs`, `run_foreground_remote_control`).
   Shelly's `codex()` wrapper always passes root `-c` overrides, so it is always foreground; Shelly
   passes `--no-daemon` explicitly anyway.
2. The foreground host creates its rendezvous socket under `std::env::temp_dir()` (`$TMPDIR`,
   `codex-rc-XXXXXX/rc.sock`), which works on Shelly (`TMPDIR=$HOME/tmp`).
3. **But every app-server unix-socket listener** (`codex-rs/app-server-transport/src/transport/unix_socket.rs`,
   `start_control_socket_acceptor`) also calls `codex_uds::prepare_shared_daemon_socket_directory()`
   and binds the *physical* socket at `<shared dir>/<sha256(canonical rendezvous path)>`; the
   rendezvous path is only a symlink to it. On Android the shared dir is hardcoded in
   `codex-rs/uds/src/daemon_directory.rs`:

   ```rust
   #[cfg(target_os = "android")]
   let (root, prefix) = ("/data/data/com.termux", "cdx-termux-");
   ...
   let temporary_root = fs::canonicalize(root)?;
   Ok(temporary_root.join(format!("{prefix}{uid}")))
   ```

   The comment states it "must not depend on HOME, TMPDIR, CODEX_HOME". There is no env override.
   Any Android app other than Termux (Shelly is `dev.shelly.terminal`) cannot resolve or write that
   path, so remote control fails before reaching the network — in both daemon and `--no-daemon` mode.
4. `codex remote-control pair` (manual pairing code) only talks to the daemon control socket
   `$CODEX_HOME/app-server-control-termux/app-server-control.sock`; it has no socket argument and is
   rejected together with `--no-daemon`. The codex-termux maintainer documented the flow as
   `codex remote-control start` + `codex remote-control pair` (codex-termux issue #15).
5. A bare `codex` TUI auto-attaches to a connectable socket at that same default daemon path
   (`codex-rs/tui/src/lib.rs`, `maybe_probe_default_daemon_socket`).

## What Shelly does (workaround, no binary patch)

- **`libexec_wrapper.so` v224** (`modules/terminal-emulator/android/src/main/jni/exec-wrapper.c`,
  already preloaded into every Codex launch) maps exactly
  `/data/data/com.termux/cdx-termux-<euid>` onto `<app data dir>/cdx`
  (`/data/user/0/dev.shelly.terminal/cdx`; short because `<dir>/<64 hex>` must fit
  `sockaddr_un.sun_path`, 107 bytes):
  - `realpath()` of `/data/data/com.termux` (and of paths under the virtual dir) returns the path
    unchanged, so `fs::canonicalize` succeeds;
  - `mkdir/mkdirat/stat/lstat/fstatat/chmod/fchmodat/unlink/unlinkat/rmdir/open/openat/symlink/symlinkat`
    and AF_UNIX `bind/connect` get the mapped path; every other call goes to the dlsym-resolved libc
    function unchanged;
  - `symlink()` targets are mapped (clients connect through the rendezvous symlink, which the kernel
    resolves without us) and `readlink()` maps them back, so Codex's own alias check still matches.
- **`shelly codex pair`** (bashrc v252) starts `codex remote-control --no-daemon` in the tab; a
  background helper waits for the new `$TMPDIR/codex-rc-*/rc.sock`, symlinks it to
  `$CODEX_HOME/app-server-control-termux/app-server-control.sock` **only for the duration of**
  `codex remote-control pair`, prints the code, and removes the link (point 5: a lingering link would
  make every later `codex` TUI silently join the remote-control host). `shelly codex code` repeats
  the pairing step from another tab.

## Proposed upstream change (codex-termux, then optionally openai/codex)

Title: `uds: let non-Termux Android hosts choose the shared socket directory (CODEX_ANDROID_SOCKET_DIR)`

File: `codex-rs/uds/src/daemon_directory.rs`

```rust
/// Returns the fixed executor-local directory that every sandbox must hide.
pub fn shared_daemon_socket_directory() -> io::Result<PathBuf> {
    #[cfg(target_os = "android")]
    if let Some(dir) = android_socket_dir_override() {
        return Ok(dir);
    }
    #[cfg(target_os = "android")]
    let (root, prefix) = ("/data/data/com.termux", "cdx-termux-");
    #[cfg(not(target_os = "android"))]
    let (root, prefix) = ("/tmp", "codex-daemon-termux-");
    let temporary_root = fs::canonicalize(root)?;
    let uid = unsafe { libc::geteuid() };
    Ok(temporary_root.join(format!("{prefix}{uid}")))
}

/// Termux keeps its fixed app-private root. Another Android app that embeds this
/// build (a different package, so /data/data/com.termux is not its uid's) names
/// the complete per-user directory instead. It must be absolute and its parent
/// must exist; prepare_shared_daemon_socket_directory() still creates it 0700
/// and rejects symlinks or a foreign owner. It is a full directory, not a root
/// plus the cdx-termux-<uid> prefix, because <dir>/<64 hex> has to fit
/// sockaddr_un.sun_path (107 bytes) and app data paths are long.
#[cfg(target_os = "android")]
fn android_socket_dir_override() -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var_os("CODEX_ANDROID_SOCKET_DIR")?);
    let parent = fs::canonicalize(dir.parent()?).ok()?;
    Some(parent.join(dir.file_name()?))
}
```

Rationale to put in the PR body:

- The fixed root exists so listeners and sandbox exclusions agree. An env var read at process start
  keeps that property as long as it is inherited by every Codex process of a session (daemon,
  foreground host, TUI, sandbox helper), which is how embedders launch Codex anyway.
- Without it, any Android app that bundles codex-termux (e.g. a terminal app with its own package)
  cannot use `remote-control`, `agents`, or the shared daemon at all, because
  `/data/data/com.termux` belongs to another app uid.
- sun_path budget: a root-only override would not work for real packages —
  `/data/user/0/dev.shelly.terminal/cdx-termux-10345/<64 hex>` is 114 bytes, over the 107-byte limit.
  Naming the whole directory lets Shelly pass `/data/user/0/dev.shelly.terminal/cdx`
  (36 + 1 + 64 = 101 bytes), the same directory the v224 workaround uses today.
- Tests: extend `codex-rs/uds/src/lib_tests.rs` with an Android-gated case that sets
  `CODEX_ANDROID_SOCKET_DIR` to a temp dir and asserts the returned path and a full-length bind.

Optional second PR (upstream ergonomics, codex-termux issue #15 territory): let
`codex remote-control --no-daemon` print a manual pairing code itself (it already holds a
connection to its embedded app-server; it could call `remoteControl/pairing/start` with
`manualCode: true` after `enable_remote_control_on_socket` succeeds), so hosts that cannot run the
daemon do not need the `pair`-through-a-link step Shelly uses.

When an override like this ships, Shelly should drop the v224 path redirect and export
`CODEX_ANDROID_SOCKET_DIR=/data/user/0/dev.shelly.terminal/cdx` from the Codex launch wrappers
instead.

## On-device verification still needed

See the P1 entry in `docs/superpowers/DEFERRED.md` ("Codex リモートコントロール").

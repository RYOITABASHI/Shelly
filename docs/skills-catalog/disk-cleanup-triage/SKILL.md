---
name: disk-cleanup-triage
description: Reclaim device or project storage by deleting genuinely reproducible files, never anything irreplaceable, and always showing what would be freed before deleting.
---
When asked to free up space (on-device storage, a build directory, a
project's local caches), work outward from the safest categories to the
riskiest, confirming before anything irreversible:

1. **Classify before deleting**: reproducible build/cache artifacts
   (node_modules, build output, downloaded toolchains, log files past a
   retention window) versus anything that's a unique source of truth
   (user data, uncommitted work, a config that took manual effort to set
   up). Never treat the second category as safe to delete just because
   it's old or large.
2. **Measure before acting.** Report what's taking the space and how much
   each candidate would free, so the human can prioritize instead of the
   agent guessing which cleanup is "enough."
3. **Prefer clearing over deleting when a safe built-in exists** — a
   package manager's own cache-clean command, a build tool's own `clean`
   task — over a manual `rm -rf` guess at what's safe, since the tool
   itself knows what it's safe to regenerate.
4. **Confirm nothing uncommitted lives inside a directory before removing
   it.** A `node_modules` or `build/` directory is normally safe, but a
   scratch/output directory can quietly accumulate a file a human meant to
   keep — a quick check beats an unrecoverable mistake.
5. **Never touch anything requiring elevated/broad storage permission
   without being explicit about what's being deleted and why** — broad
   filesystem access is a capability to use narrowly, not an invitation to
   sweep anything that looks unused.
6. **Report the before/after** (space freed, what was removed, what was
   left alone and why) so the cleanup is auditable after the fact, not just
   a silent "done."

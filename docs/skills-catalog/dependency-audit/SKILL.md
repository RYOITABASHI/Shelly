---
name: dependency-audit
description: Triage outdated and vulnerable dependencies by real upgrade risk before touching any lockfile, instead of bulk-bumping everything.
---
When asked to check or clean up a project's dependencies, separate
"what's outdated" from "what's actually worth changing right now":

1. **List what's outdated and what's flagged vulnerable separately** — an
   old-but-fine transitive dependency is a different priority from a
   direct dependency with a known CVE in a code path this project actually
   exercises.
2. **Check whether a flagged vulnerability is reachable.** A vulnerable
   function in a dependency that this project never calls is lower urgency
   than one on a path handling user input, auth, or file/network access —
   say which applies before recommending an urgent bump.
3. **Read the changelog/migration notes for a major-version bump**, not
   just the version number — a semver-major bump can carry breaking API
   changes, dropped Node/runtime support, or a license change; never bump
   a major version "because it's outdated" without checking what changed.
4. **Group the work into safe-now vs. needs-testing.** Patch/minor bumps
   with no reported breaking changes can usually be batched; anything major
   or anything touching a security-sensitive dependency should be its own
   change with its own test pass, not folded into a big "update everything"
   commit.
5. **Never edit a lockfile by hand.** Use the package manager's own update
   command so the lockfile's integrity hashes stay consistent — a
   hand-edited lockfile is a common source of "works on my machine" drift.
6. **Report what you didn't change and why** (pinned for a reason, breaking
   change not yet worth the churn, no fix available yet) so the next audit
   doesn't waste time re-investigating the same decision.

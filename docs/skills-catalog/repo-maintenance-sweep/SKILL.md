---
name: repo-maintenance-sweep
description: Run a periodic repo-hygiene pass (stale branches, uncommitted work, dependency drift, stray TODOs) instead of letting small maintenance debt accumulate silently.
---
For a scheduled or on-demand "clean up this repo" sweep, work through these
checks in order, reporting findings before touching anything destructive:

1. **Uncommitted/unstashed work first.** `git status` — never run cleanup
   steps that could discard work before confirming nothing valuable is
   sitting uncommitted. If auto-savepoints exist for this repo, check
   whether recent savepoints already cover the working tree, or whether
   there's newer work a savepoint hasn't captured yet.
2. **Stale branches.** List local branches merged into the main branch
   (`git branch --merged`) as deletion candidates, and local branches with
   no upstream and no recent commits as "probably abandoned, confirm before
   deleting" — never force-delete a branch that isn't merged without
   surfacing it for a human decision first.
3. **Dependency drift.** Check for a lockfile that's out of sync with the
   manifest (e.g. `pnpm install --frozen-lockfile` failing) and outdated
   direct dependencies — report what's outdated and any that carry a known
   vulnerability, but don't bump versions yourself unless asked; a
   dependency bump is a change that deserves its own reviewed commit.
4. **Stray TODO/FIXME/debug artifacts.** Grep for `TODO`/`FIXME`/leftover
   `console.log`/debug-only code paths that look forgotten rather than
   intentional, and list them with file:line rather than silently deleting
   — the author may have context you don't.
5. **Doc/reality drift.** If the project keeps a "deferred work" or
   architecture-decisions doc, spot-check a few entries against current
   code — a maintenance sweep that only touches code and never notices a
   doc has gone stale reintroduces exactly the kind of drift this skill
   exists to catch.
6. **Summarize as a punch list**, not a wall of raw command output: what's
   safe to auto-fix, what needs a human decision, and what's fine to leave
   as-is with a one-line reason.

---
name: git-commit-craft
description: Write small, scoped, well-explained git commits instead of one giant dump of unrelated changes.
---
Before committing, group the working-tree diff into the smallest set of
logically-independent commits:

1. Run `git status` and `git diff` (staged and unstaged) first — never guess
   at what changed.
2. If the diff touches more than one concern (e.g. a bug fix AND an unrelated
   refactor, or app code AND a config/docs tweak), split it into separate
   commits with `git add <specific files>` rather than `git add -A`.
3. Write the subject line in the imperative mood ("fix", "add", "refactor" —
   not "fixed"/"adds"), under ~70 characters, and make it describe the
   *effect* of the change, not a literal file list.
4. Use the body (a blank line after the subject, then free text) to explain
   *why* the change was made, not what the diff already shows line-by-line.
   Call out anything a reviewer would otherwise have to reverse-engineer:
   a bug's root cause, a tradeoff you chose, a follow-up you deliberately
   deferred.
5. Never bundle a secret, credential, or generated/binary artifact into a
   commit "just to get it done" — stop and ask if you're unsure whether a
   file belongs.
6. After committing, run `git log --oneline -5` and `git status` to confirm
   the commit landed as intended and nothing was left uncommitted or
   accidentally staged.

If the repo has its own CLAUDE.md/CONTRIBUTING commit-message convention
(e.g. Conventional Commits, a required trailer, a specific verb list),
that project-specific rule always wins over the generic guidance above.

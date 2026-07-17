---
name: shell-safety-review
description: Sanity-check a shell command for destructive or irreversible side effects before running it, especially in an autonomous/unattended run.
---
Before executing a shell command that was generated (by yourself or another
model) rather than typed by a human in the moment, scan it for these
red flags and stop to confirm with the user if any are present:

- **Recursive/forced deletion**: `rm -rf`, `rm -f *`, `find ... -delete`,
  emptying a trash/cache directory that wasn't explicitly named by the user.
- **Overwrite-in-place without a check**: `> file` (truncates silently),
  `mv` over an existing path, `git checkout -- .` / `git reset --hard` /
  `git clean -fd` (discards uncommitted work) — verify there's nothing
  uncommitted worth keeping first (`git status`, `git stash` if unsure).
- **Wide-scope operations**: a glob or wildcard that could match more than
  the intended target (`chmod -R`, `chown -R`, `rm dir/*` from the wrong
  cwd) — print `pwd` and `ls` the target first if there's any ambiguity.
- **Credentials/secrets in plain sight**: a command that echoes, logs, or
  commits an API key, token, or password — redact or route through a secret
  manager instead.
- **Network calls to non-obvious hosts**: `curl`/`wget` piped straight into
  `sh`/`bash` (`curl ... | sh`), or a request to a host the user never
  mentioned — read the script first instead of blind-piping.
- **Force-push or history rewrite**: `git push --force` (especially to
  `main`/`master`), `git rebase` on a shared branch, `--no-verify` to skip
  hooks — these need explicit human sign-off, not a "looked right" pass.
- **Background/detached processes that outlive the session**: `nohup ... &`,
  `disown` — confirm the user wants a long-running process left behind.

If none of these apply, proceed normally. If one does, don't silently
"fix" the command yourself — explain the specific risk in plain language
and ask whether to proceed, adjust the scope, or skip it.

---
name: agent-skill-authoring
description: Write a well-formed SKILL.md (agentskills.io format) so it imports cleanly and actually gets used.
---
A SKILL.md has two parts: YAML frontmatter (metadata used to find and trust
the skill) and a markdown body (the actual instructions). Both have rules
that matter for whether the skill imports successfully and whether an agent
will actually apply it at the right moment.

**Frontmatter**:
- `name`: lowercase letters, digits, and hyphens only; no leading or
  trailing hyphen (e.g. `git-commit-craft`, not `Git_Commit_Craft` or
  `-git-commit-craft-`). It must exactly match the folder name the file
  lives in — a mismatch is a hard import error, not a warning.
- `description`: one line, no YAML block scalars (`|` or `>`). Write it as
  a *trigger condition*, not a summary — "Write small, scoped git commits
  instead of one giant dump" tells a matcher when to reach for this skill
  far better than "A skill about git commits."
- Keep both fields on a single line each; the parser does not support
  multi-line frontmatter values.

**Body**:
- Lead with the concrete procedure, not background/motivation — an agent
  reads this under time pressure mid-task, not as a tutorial.
- Prefer a numbered or bulleted checklist over prose paragraphs; it's
  easier for a model to follow step-by-step and easier for a human
  reviewer to skim during the quarantine/approval step.
- Keep it short. Aim for well under ~5000 estimated tokens (roughly
  20,000 characters) — an oversized skill body eats into the context
  budget of whatever task it gets injected into, and importers may warn
  on outsized bodies.
- Call out exceptions and escape hatches explicitly ("if X, stop and ask"
  rather than silently guessing) — a skill that never yields control back
  to the human is a liability, not a convenience.
- Never embed a secret, credential, or executable payload in the body —
  the body text is exactly what gets shown during human review before
  approval, and exactly what gets sent to a model once approved; treat it
  as fully untrusted-until-reviewed content on both ends.

**Before publishing/sharing a skill**: read it back as if you were the
reviewer approving someone else's import — would you trust these
instructions blind? If not, tighten the wording until you would.

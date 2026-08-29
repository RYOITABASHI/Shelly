---
name: code-review-checklist
description: Review a diff systematically for correctness, safety, and test coverage before approving it, instead of skimming for obvious typos.
---
Before approving or merging a change (yours or another agent's), work
through the diff in this order rather than reading it top-to-bottom once:

1. **Understand the stated intent first.** Read the commit message/PR
   description/plan before the diff itself — you can't judge whether a
   change is correct without knowing what it's supposed to accomplish.
2. **Check correctness on the actual change, not just style.** Does the
   logic do what it claims? Are edge cases (empty input, zero, null/undefined,
   the boundary of a range) handled or at least considered? Trace through
   one concrete example by hand rather than trusting that it "looks right."
3. **Look for scope creep.** A diff that bundles an unrelated refactor,
   formatting-only churn, or a second unrelated fix makes the real change
   harder to review and harder to revert independently — flag it to be
   split, don't just wave it through.
4. **Check what tests changed (or didn't).** A behavior change with no test
   change is a red flag: either a test should have changed and didn't
   (regression risk) or no test covers this path at all (coverage gap) —
   both are worth calling out explicitly rather than assuming it's fine.
5. **Check for the safety-sensitive patterns specifically**: destructive
   shell commands, credentials/secrets touched, widened permission scope,
   a changed validation/sanitization rule — these deserve slower, more
   skeptical reading than a typical logic change.
6. **Give actionable feedback, not just a verdict.** If you'd block it,
   say exactly what would need to change to unblock it; if you'd approve
   with reservations, say what to watch for after merge rather than
   silently accepting residual risk.

---
name: incident-postmortem
description: Write a blameless postmortem that identifies the real root cause and a concrete follow-up, instead of a narrative that just restates what happened.
---
After a production or on-device incident (a crash, an outage, a bad
release, an agent that took an unintended action), write the postmortem in
this structure rather than a loose chronological retelling:

1. **State the impact first, in concrete terms.** Who/what was affected,
   for how long, and how severely — a postmortem that opens with root
   cause before impact makes the reader guess how much this actually
   mattered.
2. **Build a factual timeline before analyzing.** What was observed, and
   when, using timestamps/log lines/commit hashes where available —
   establish what's known before moving to why it happened, so speculation
   doesn't get mixed into the factual record.
3. **Find the root cause, not just the trigger.** The trigger is what set
   the incident off (a specific commit, a specific input); the root cause
   is why the system allowed that trigger to cause this much damage (a
   missing check, an untested path, an alert that didn't fire) — a
   postmortem that stops at the trigger will recur with the next similar
   trigger.
4. **Stay blameless.** Describe what the system/process allowed, not who
   made a mistake — "the deploy pipeline had no rollback safeguard" is
   useful; "person X pushed a bad commit" is not, even if factually true,
   because it doesn't prevent the next incident.
5. **Write follow-ups as specific, assignable actions**, not vague
   intentions — "add a pre-deploy check for X" beats "be more careful next
   time." An action with no owner or no way to verify it happened isn't a
   real follow-up.
6. **Distinguish what actually fixed the immediate issue from what
   prevents recurrence** — a hotfix and a systemic fix are both worth
   recording, but conflating them hides whether the underlying risk is
   actually closed.

---
name: privacy-local-only-analysis
description: Keep a sensitive task strictly on-device (local LLM only), refusing the normal cloud-escalation ladder even when the local model struggles.
---
Some tasks (personal journal entries, health notes, financial details,
anything the user explicitly marks private) must never leave the device,
even when the on-device model would normally escalate to a free cloud API
or Codex for a better answer. Treat "stay local" as a hard constraint, not
a preference:

1. **Confirm the constraint before starting**, not after a partial answer —
   if the task or its input is plausibly sensitive and the user hasn't said
   whether cloud escalation is acceptable, ask first rather than assuming
   either way.
2. **Never forward the input itself to a cloud API "just to check the
   answer"** — not even a summarized or redacted version, unless the user
   explicitly approved that specific escalation for this run. The tool
   escalation ladder existing as a general feature doesn't mean it applies
   to every task; a privacy-constrained run opts out of it entirely.
3. **Size the task to the local model's real capability.** If the on-device
   model can't reliably do the full task, narrow the ask (shorter input,
   simpler output format, more steps with smaller scope each) rather than
   quietly reaching for a bigger model elsewhere.
4. **Say plainly when the local-only answer is lower confidence** than a
   cloud model would likely give, so the user can decide whether to accept
   it as-is or explicitly authorize an escalation for this one run.
5. **Don't persist the sensitive input anywhere it doesn't need to be** —
   avoid writing raw sensitive content into a shared digest, log, or
   memory file when a redacted summary would serve the same purpose.
6. **If a multi-step chain is involved, verify every step honors the same
   constraint** — a privacy-preserving first step feeding into a later step
   that calls a cloud API defeats the whole point; the constraint applies to
   the entire chain, not just the step it was stated for.

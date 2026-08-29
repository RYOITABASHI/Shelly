---
name: app-act-flow-design
description: Design a safe, narrowly-scoped App-Act recipe (cross-app UI automation) before registering it for unattended use.
---
App-Act drives another app's UI on the user's behalf (currently: posting to
X), and because the recipe is reviewed once at registration and can then
fire unattended, the recipe itself has to be trustworthy by construction —
not just "probably fine" at review time:

1. **Scope the recipe to the single action it needs to perform**, not a
   general "operate this app" capability. A recipe for "post this text to X"
   should not also be able to browse, follow, like, or delete — narrower is
   safer and easier for the human reviewer to actually verify.
2. **Make every variable part of the recipe explicit at registration time.**
   If the recipe fills in a template with run-time content (the post text,
   a target field), state exactly what varies and what's fixed, so the
   human reviewing it isn't approving an open-ended "whatever the agent
   decides" flow.
3. **Add a sanity check the recipe itself enforces** before the final
   irreversible tap — e.g. refuse to fire if the composed content is empty,
   suspiciously long, or contains an obvious placeholder/error string that
   means an earlier step failed silently.
4. **Assume the target app's UI can change.** Note what the recipe expects
   to see (a specific button, layout, field order) so a future UI change
   fails loudly (recipe errors out) rather than silently tapping the wrong
   element because a layout shifted.
5. **Never let a recipe approved for one target app get reused for a
   different one** by just swapping a package name — a recipe's trust comes
   from the specific reviewed flow, and a different app's UI/semantics
   invalidate that review even if the automation steps look superficially
   similar.
6. **Log what the recipe actually did on each run** (which fields it filled,
   what it tapped) so a bad run is diagnosable after the fact instead of
   just "it posted something, not sure what."

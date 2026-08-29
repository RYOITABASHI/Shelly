---
name: notification-triage
description: Decide whether an incoming notification-triggered agent run actually warrants an action, instead of firing every time the trigger matches.
---
A notification-triggered agent (one that wakes up when a specific
app/thread posts a new notification) is easy to make either too noisy
(fires on everything) or too quiet (misses the one that mattered). Before
taking any action, run this triage:

1. **Restate what changed, in one sentence**, before deciding what to do
   about it. If you can't summarize the triggering notification cleanly,
   don't act on it yet — re-read it instead of guessing.
2. **Check it against the actual reason this agent exists.** A DM-triggered
   agent registered to catch "is this urgent?" messages shouldn't act on
   routine chatter just because it matched the sender/thread filter —
   apply the *intent* filter, not just the trigger filter.
3. **Pick the lowest-privilege action that satisfies the intent.** A
   one-tap Notify is enough for "flag this for the user later"; a DM Reply
   or CLI action (which always requires an in-app Review tap) should only
   be reached for when a reply or a command genuinely needs to happen
   before the user is back at the device.
4. **Never chain a notification trigger straight into an unattended
   high-privilege action** (CLI, Intent/share, DM Reply) without the
   Review tap the app already requires for those — don't try to route
   around that gate by reformulating the action as something lower-risk
   that isn't actually equivalent.
5. **When in doubt about urgency, under-react, not over-react** — draft a
   file note or queue a Notify rather than replying/posting/running a
   command on the user's behalf; a missed low-stakes notification costs
   less than an unwanted autonomous reply sent from the user's account.
6. **Log why you did or didn't act**, briefly, so a later review of this
   agent's run history explains its own decisions instead of just showing
   a stream of unexplained skips.

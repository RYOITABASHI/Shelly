---
name: build-health-monitor
description: Periodically check CI/build status and catch a regression trend early, instead of only noticing a broken build when someone hits it.
---
For an agent that periodically checks a project's build/CI health (e.g. a
GitHub Actions workflow's recent runs), aim to surface a developing problem
before it blocks someone, not just report the latest single run's status:

1. **Look at the trend, not just the latest run.** A single red run could
   be a flake; three reds in a row on the same step is a real regression —
   distinguish "noisy but recovering" from "consistently broken" before
   deciding how loudly to alert.
2. **Identify which step/job actually failed**, not just "the build
   failed" — point at the specific failing step and, if the log makes it
   obvious, a plausible root cause (a specific test, a dependency
   resolution failure, a timeout) rather than making the reader dig through
   the full log themselves.
3. **Watch for slow degradation, not just hard failures** — a build/test
   suite that's steadily getting slower run over run is worth flagging
   before it becomes a timeout failure, since that's a much easier problem
   to fix early.
4. **Correlate a new failure with what changed.** If the failure started
   after a specific commit/PR merged, say so — that's the single most
   useful piece of information for whoever fixes it.
5. **Don't alert on every single failed run of an already-known, tracked
   issue.** If the same failure has already been reported and isn't
   resolved, a daily re-alert about the identical problem trains the
   reader to ignore this agent's notifications entirely — mention it's
   still open in a periodic digest instead of re-firing a full alert.
6. **Escalate urgency appropriately**: a broken `main` branch build blocking
   everyone deserves an immediate Notify; a single feature branch's failing
   run is a lower-urgency digest item.

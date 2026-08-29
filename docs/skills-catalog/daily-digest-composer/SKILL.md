---
name: daily-digest-composer
description: Compose a scheduled digest (daily/weekly) that is skimmable in ten seconds instead of a raw dump of everything collected during the run.
---
When a scheduled agent's job is to collect information (logs, notifications,
research results, repo activity) and deliver a periodic digest, build the
digest in this shape rather than pasting raw output:

1. **One-line headline first.** The single most important fact from this
   run, even if it's "nothing notable happened" — never bury the lede under
   a wall of collected data.
2. **Group by section, not by source.** A reader cares about "what changed"
   and "what needs a decision," not which tool produced which line. Merge
   overlapping items from different sources into one bullet.
3. **Cap the length deliberately.** Pick a target (e.g. 5-10 bullets) before
   writing, then cut the least important items rather than shrinking every
   item to fit — a digest that's always the same length stops getting read.
4. **Flag anything that needs a human decision separately** from pure FYI
   items, so the reader can triage in one pass (e.g. a "needs input" section
   vs. a "for your info" section).
5. **Match the delivery channel to the content.** A short digest fits a
   device notification (Agent Action: Notify); a longer one belongs in a
   file (Agent Action: Draft, e.g. an Obsidian vault note) that the
   notification can point to instead of trying to cram everything into the
   notification body.
6. **Carry state between runs when "what changed since last time" matters**
   — note the timestamp/marker of what was already reported so the next
   run doesn't re-report the same items, and say explicitly when a period
   had zero new items instead of silently omitting the section.

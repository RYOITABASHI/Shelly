---
name: browser-change-watch
description: Design a browser-pane page-change monitoring agent that alerts on a real change, not on every reload's incidental noise.
---
A recurring agent that reloads a page in the browser pane and reports
"did this change?" is prone to false positives unless it's designed around
what actually varies on the page versus what's the real signal:

1. **Pick the narrowest element that represents the thing you care about**
   (a price, a status badge, a specific list) instead of comparing the
   whole page's HTML/text — timestamps, ads, view counters, and A/B-test
   markup change on every load and will drown out the real signal.
2. **Normalize before comparing**: strip whitespace differences, sort
   list-like content if order isn't meaningful, and ignore known-noisy
   substrings (session ids, cache-busting query params rendered into the
   page) rather than diffing raw text byte-for-byte.
3. **Confirm a change twice before alerting** when the target is known to
   be flaky (a page that sometimes serves a loading skeleton or an error
   page) — a single-read false positive that pages the user erodes trust in
   the whole agent faster than a slightly delayed real alert.
4. **Alert with the actual delta, not just "it changed."** Show the old
   value and the new value in the notification/digest so the user doesn't
   have to reopen the page to find out what happened.
5. **Escalate through Notify by default, not a higher-privilege action.**
   Only wire a change straight into a CLI/Intent/App-Act action when the
   response is truly mechanical and was explicitly reviewed for that
   specific page+condition at registration time — "the page changed" is a
   weak precondition for firing an unattended side-effecting action.
6. **Record the last-seen value between runs** so the comparison is always
   "since last check," not "since the agent was created" — otherwise every
   run after the first either re-fires on old news or silently forgets what
   it already reported.

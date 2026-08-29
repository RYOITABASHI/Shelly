---
name: social-post-drafting
description: Draft a platform-appropriate social/chat post before an agent's Social Post or App-Act action publishes it, instead of posting the raw run output.
---
An agent that ends in a Social Post (Discord/Slack/Telegram/Mastodon/
Misskey/WordPress/Bluesky connector) or App-Act (e.g. X) action is one step
away from publishing something publicly and irreversibly. Draft the post
itself as a distinct step, not as a byproduct of the run's raw output:

1. **Write for the platform, not for yourself.** A Discord/Slack update can
   use more structure (headers, bullets); X/Bluesky/Mastodon need a single
   tight thought within the platform's length norms; a WordPress post is a
   different register entirely (a title + body, not a one-liner). Don't
   reuse one draft verbatim across connectors.
2. **Strip anything that was scratch reasoning, not the intended message.**
   The run's internal notes ("let me check...", tool call summaries,
   intermediate drafts) must never leak into the published text — reread
   the draft as a stranger would see it before finalizing.
3. **Never include a secret, token, internal path, or another person's
   private information** in a public post, even if it appeared incidentally
   in the source data the agent was summarizing.
4. **Respect the one-agent-per-connector limit**: don't try to fan the same
   content out to multiple platforms from a single Social Post agent —
   each platform needing the same content means a separate registered
   agent per connector today.
5. **Remember X/Twitter posting goes through App-Act, not the Social Post
   connector system** — its recipe and target were reviewed once at
   registration, which is what allows it to fire unattended; that trust
   was placed in the *specific recipe*, not a blanket "post whatever" — stay
   within what the recipe was actually approved to do.
6. **When the content is ambiguous, ironic, or could be misread out of
   context** (sarcasm, a quote, a partial fact), either drop it from the
   post or make the framing unambiguous — a public post has no space to
   add "I meant this differently" afterward.

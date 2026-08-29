---
name: meeting-notes-summarizer
description: Turn raw meeting notes or a voice transcript into clear decisions and action items, instead of a re-formatted wall of everything that was said.
---
When given raw notes or a transcript from a meeting/call and asked to
summarize it, produce something the reader can act on, not a shorter
version of the same firehose:

1. **Separate decisions from discussion.** A meeting usually contains far
   more back-and-forth than actual decisions — pull out only what was
   actually decided or agreed, and treat exploratory discussion as
   background, not as an output section by itself.
2. **Extract action items with an owner and, if stated, a deadline.** An
   action item with no owner is not actionable — if the transcript doesn't
   name one, say "owner unclear" rather than silently assigning it or
   silently dropping it.
3. **Flag open questions separately** from decisions and action items — a
   question that was raised but not resolved needs to stay visible, not
   disappear because it didn't reach a conclusion in this meeting.
4. **Don't over-attribute from an unreliable transcript.** Voice
   transcription misattributes speakers and mishears words; when a
   transcript is noisy, hedge attribution ("someone raised...") rather than
   confidently naming the wrong person as having said something.
5. **Keep the summary shorter than the source by a wide margin.** If the
   summary is nearly as long as the notes, it hasn't actually distilled
   anything — cut context that doesn't change what the reader needs to do
   next.
6. **End with a short "what happens next" line** tying the action items
   together, so the reader doesn't have to reconstruct the overall plan
   from a bullet list.

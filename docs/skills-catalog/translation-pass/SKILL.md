---
name: translation-pass
description: Add or update a translated string so it matches every locale's keys and tone, instead of leaving locale files out of sync.
---
When a project keeps separate locale files (e.g. one file per language,
each exporting the same set of keys) and a new or changed UI string needs
translating, treat "every locale in sync" as the actual deliverable, not
just "the string I was asked about":

1. **Find every locale file, not just the one you were given an example
   in.** A change made in only one language silently breaks parity — grep
   for the key across all locale files before considering the change done.
2. **Match the existing key naming and nesting convention exactly.** Don't
   introduce a new naming style (flat vs. nested, casing convention) for
   one new string when the surrounding file already has an established
   pattern.
3. **Translate meaning, not words.** A literal word-for-word translation
   often reads unnaturally; prefer the phrasing a native speaker would
   actually use for that UI context (a button label, an error message, a
   long-form description each have different natural registers).
4. **Preserve placeholders and formatting exactly** (`{count}`, `%s`, HTML
   tags embedded in the string) — a translation that drops or reorders a
   placeholder will crash or silently produce garbled output at runtime.
5. **Keep length in mind for space-constrained UI** (buttons, tab labels,
   short badges) — a technically correct translation that's far longer than
   the original can break layout; prefer a shorter equivalent phrasing when
   the UI slot is narrow.
6. **Flag any string you're unsure how to translate naturally** (idioms,
   culture-specific references, ambiguous source phrasing) rather than
   guessing silently — a marked "needs native review" beats a confidently
   wrong translation shipping unnoticed.

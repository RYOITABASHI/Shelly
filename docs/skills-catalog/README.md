# Shelly first-party skill catalog (SKILL-002)

This directory is the source of truth for Shelly's curated skill catalog —
the seed content for the `skills-catalog-latest` GitHub Release channel that
`lib/skill-catalog.ts` fetches (see `docs/superpowers/DEFERRED.md`'s
SKILL-002 entry for the full design writeup and the CI-publish follow-up).

- `skills-catalog.json` — the manifest, in the exact shape
  `lib/skill-catalog.ts`'s `parseSkillCatalogManifest()` validates. Each
  entry's `sha256` is the real sha256 of the corresponding `SKILL.md` file in
  this directory (`sha256sum <name>/SKILL.md`).
- `<name>/SKILL.md` — one curated skill per folder, in the `agentskills.io`
  SKILL.md format `lib/skill-import.ts` already validates for local imports.

## How this becomes a live catalog

`fetchSkillCatalogManifest()` reads a `skills-catalog-latest` GitHub Release
tag's `skills-catalog.json` asset — the same pattern `.github/workflows/
build-android.yml`'s "Publish Android update release" step already uses for
`android-latest`/`latest.json` and `codex-runtime-latest`/`codex-runtime.json`.
Wiring an equivalent publish step for this channel (upload this directory's
`skills-catalog.json` + each `SKILL.md` as release assets, with `contentUrl`
pointing at the resulting asset download URLs) is a follow-up, not yet done —
see the DEFERRED.md entry. Until it lands, `fetchSkillCatalogManifest()`
gets a 404 from GitHub and returns `null`, and Sidebar's catalog browse
modal shows "not available yet" — a safe, non-crashing degradation.

## Adding or editing a skill

1. Add/edit `<name>/SKILL.md` (must pass `lib/skill-import.ts`'s
   `validateSkillMdContent` — lowercase-hyphen `name` matching the folder,
   a single-line `description`, no YAML block scalars).
2. Recompute its sha256 (`sha256sum <name>/SKILL.md`) and update the
   matching entry in `skills-catalog.json`.
3. Keep skills small and genuinely useful — this is a curated catalog, not
   a dumping ground.

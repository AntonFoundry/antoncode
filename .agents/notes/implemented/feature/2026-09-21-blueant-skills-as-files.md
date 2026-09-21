# Blueant skills-as-files surface

Date: 2026-09-21
Scope: apps/anton-bridge/src/blueant-preset.ts, deployment skills dir

## Problem

Arivu's lesson: capabilities users can see and shape beat sophisticated
ones they cannot. Blueant had no user-extensible surface — the popup's
behavior was fixed by the preset, and "add a small routine" (a morning
brief, a where-was-I) meant shipping code.

## Decision

Blueant skills are files, per the harness's existing skill architecture —
which already puts skill discovery in the preset layer (the web deployment
deliberately disables host-level `skill-filesystem`/`tool-skill`; presets
own local discovery). The Blueant preset now mounts:

- `skill-filesystem` — registers into the preset's layer; discovers
  directory-bundle skills from `<dshHome>/skills/<name>/SKILL.md` (YAML
  frontmatter `name`/`description` + markdown body).
- `tool-skill` — the `skill` catalog/loader tool, added to the restrict
  roster after `blueant_propose`.

A Blueant skill is instructions plus tool usage, no code: the body tells
the agent which sources to read (journal files, `c0ntext_search`,
`mail_query`-class tools) and the answer's shape. The frontmatter
`description` ("use when …") is the catalog trigger. Anything beyond
reading routes through `blueant_propose` (user-approved).

`ensureBlueantProfileLink` now junction-links the two skill packages into
the profile's node_modules alongside persona (preset rows resolve bare
names from there).

## Related notes

Extends the preset tool-roster mechanism documented in
`2026-09-20-blueant-capture-tier.md` (existsSync-guarded preset writes;
deployed copies edited in place). No supersession: the roster mechanism is
unchanged, this adds to it.

## Deployment (live home)

- Live preset yml updated with the same rows/roster (guarded writes never
  clobber existing presets, so the live copy was edited to match).
- Skills shipped: `daily-brief` (journal + triaged memory + mail digest)
  and `where-was-i` (last-working-state reconstruction), plus a
  `skills/README.md` documenting the surface for the user.

## Verification

Packages resolve from the live profile (`import` smoke); preset rows match
the web bundle's documented preset-owns-skills layering. End-to-end
popup verification is user-driven (open Blueant, ask "where was I") — the
catalog lists both skills by description and loads the body on match.

## Deferred

- A preset cache in the harness (if any) is cleared by restart; the new
  resume-note plugin makes that interruption self-explaining.
- Skill sharing (git repo of skills) once more than a handful exist.

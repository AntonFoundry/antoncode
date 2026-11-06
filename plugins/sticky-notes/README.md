# Sticky notes

## Summary

An opt-in local DSH bundle providing a colorful sticky-note wall from the left sidebar. It is not enabled by shipped profiles, is outside the pnpm workspace, and the Anton platform packagers exclude the repository's root `plugins/` directory.

## Install and use

Install this directory through Plugin Manager or the `plugin_manager` tool with `action: install_bundle` and the directory's absolute path. Installation affects the current profile; the checked-out directory remains the linked source, so keep it available.

Open **Sticky notes** in the sidebar, write an idea, and choose **Stick it**, or press Command/Ctrl+Enter. Notes appear newest first. Each note has a Delete control; deletion is immediate.

## Storage and limitations

Notes use browser localStorage under `@local/sticky-notes/wall`. They survive ordinary reloads in that browser and origin, but are not synced to other browsers or machines. Clearing site data removes them. The agent cannot read the wall through a tool, and notes are not part of Session history. Export or copy valuable ideas elsewhere before clearing browser data.

A storage read or write failure is reported in the panel. Failed writes retain the draft or existing notes for retry. Unreadable or malformed saved data is not overwritten by the wall. Concurrent browser tabs are not coordinated; use one wall tab when editing notes.

## Development

The Host entry is empty. The browser entry registers a glyph in `sidebar.panellist` and the matching `sticky-notes` key in `main`. It consumes host React, slots, locale, and theme tokens; no network requests or additional processes are needed.

The owner-local regression suite is `apps/web/tests/sticky-notes.client.spec.ts`; packaging exclusions are covered by `scripts/local-plugin-packaging.spec.ts`.

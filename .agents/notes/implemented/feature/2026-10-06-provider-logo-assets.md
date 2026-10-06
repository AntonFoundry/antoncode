# Agent Note: Local provider logo assets

Status: implemented

## Problem

The model picker and Models settings page identify provider routes by name. A monochrome icon set does not preserve each provider's current color, background, or product mark, and separate page implementations can drift.

## Decision

The web app stores provider artwork in [`apps/web/public/assets/providers`](../../../../apps/web/provider-assets.md). `ProviderLogo` in `ui-primitives` maps stable route IDs to those local files. The composer model picker and Models settings rows use the same component. An unknown route displays its initial without requesting artwork from an arbitrary provider endpoint.

## Alternatives considered

**Bundled monochrome vector paths.** They are small but discard the provider's color and current product mark; the OpenCode mark already differed from its site favicon.

**Runtime favicon downloads.** They add network work, third-party requests, and image failures to local UI rendering, and a provider endpoint may not identify the company named by a configured route.

## Consequences

Both screens render the same artwork offline and keep the source of each asset reviewable. Adding a known provider requires an asset and a route mapping. Custom providers receive a neutral initial until an explicit asset is added.

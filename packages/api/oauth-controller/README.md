---
description: "Authenticated Remote methods for OpenCode Zen and Claude subscription sign-in from the Models page."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-oauth-controller

English

## Summary

Start OpenCode Zen or Claude subscription sign-in from the Models page and follow its progress without moving stored credentials into the browser. The Host keeps pending attempts and token exchange in the provider plugins. The browser receives device codes, approval links, workspace choices, and terminal status.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

The Web composition mounts this controller beside the OpenCode and Claude LLM plugins. The `oauth` namespace starts, inspects, completes, and cancels their Host-owned login flows. An unknown login ID is rejected, and a missing provider flow is reported as unavailable. The Models page calls these methods through its operations layer.

## Model Experience

None, as sign-in changes Host credentials without adding model-visible content to a Session.

#### KV Cache effect

No direct effect; a later model request uses the selected provider's own credential handling.

## Known Limitations and Deferred Work

- Login attempts live in the Host process and do not survive a restart; start a new attempt after reconnecting to a restarted Host.

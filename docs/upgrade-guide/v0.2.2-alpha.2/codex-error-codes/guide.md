---
kind: upgrade-guide
description: "Codex streamed quota failures use QUOTA, and structured availability failures use OVERLOADED or MODEL_UNAVAILABLE."
---

# Codex provider failure codes

## Change

Consumers of the Codex adapter's terminal failures receive `QUOTA` instead of the inconsistent SSE-only `QUOTA_EXCEEDED` for `insufficient_quota` and `billing_not_active`. HTTP and Responses SSE also recognize explicit provider overload and model-availability codes as `OVERLOADED` and `MODEL_UNAVAILABLE`, rather than generic `SERVER`, `HTTP_404`, or `TRANSPORT`. Authentication, context overflow, and explicit invalid-request failures remain distinct. These classifications report failure facts; they do not enable automatic retries or route switching.

## Migration

1. In custom consumers of `ctx.llm.stream()` or `agent/request-error`, replace Codex-specific checks for `failure.code === 'QUOTA_EXCEEDED'` with `failure.code === 'QUOTA'`. Preserve compatibility checks only if another configured adapter still emits the old spelling.
2. Update any handling that deliberately depends on generic Codex `SERVER`, `HTTP_404`, or `TRANSPORT` outcomes to account for the explicit `OVERLOADED` and `MODEL_UNAVAILABLE` classes. Do not interpret unclassified errors as model unavailability.
3. Confirm with local provider fixtures that `insufficient_quota` produces `QUOTA`, structured overload produces `OVERLOADED`, and `model_not_found` produces `MODEL_UNAVAILABLE`; verify authentication and invalid requests do not enter availability recovery. No settings or stored Session migration is required.

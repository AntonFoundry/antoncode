# Agent Note: llm-pi-ai catalog union + generalized live refresh; nvidia route

Status: implemented

English

## Problem

Two model-menu failures compounded. First, `resolveRouteModels` served exactly one of three mutually exclusive sources — a configured `models` list, a discovered live listing, or the installed catalog — so a partial list *replaced* the route's catalog and hid models such as `deepseek-v4.1-flash` and `kimi-k3` from the pickers. Second, the live models.dev refresh was hardwired to the `zai` route, so no other route ever learned new provider ids. Separately, the tree did not typecheck: `CredentialRef | undefined` narrowing errors in `llm-openai`/`llm-models-dev`, a missing `unlinkSync` import in `anton-rebuild`, and `apps/anton-bridge/src/blueant-preset.ts` absent from `tsconfig.host.json`'s file list.

## Decision

`resolveRouteModels` now unions: configured/live entries win by id and catalog-only models always remain served (catalog tail keeps `modelOverrides`, which continues to refuse an override that lands nowhere). Naming an override for a model a `models` list also declares stays a loud error — declare the fields on the entry. Live refresh keys off a `MODELS_DEV_ROUTE_PROVIDERS` map (`zai`, `moonshotai`, `deepseek`, `nvidia`), reads one shared models.dev document per settings generation, applies Z.AI's effort spellings only to the zai route (other routes' unknown ids stay neutral), keeps the endpoint-listing fallback for OpenAI-compatible routes only, and skips routes that pin a `models` list or name no credential — a keyless profile is a deliberate catalog-only shape, and the gate keeps unit tests off the network. Per-route in-flight promises replace the single-flight `zai` flag.

The `nvidia` route itself is pure configuration (pi-ai ships the builtin endpoint): `apiKeyEnv: NVIDIA_API_KEY`, `api: openai-completions`, `models: [z-ai/glm-5.3-flash]` in the settings layer. The narrowing fixes preserve the loud `MISSING_CREDENTIAL`/error contract; `request`/`requestResponses` widen their `apiKey` parameter to `string | undefined`, which their bodies already handled.

## Verification

No new test failures against the pre-change baseline of the damaged tree: the pi-ai suites updated for union semantics (`models` extends the catalog, live listing first with catalog tail, override-ambiguity message) pass, `tsc -b tsconfig.host.json` is clean, and a source-level probe lists `z-ai/glm-5.3-flash` plus 30 live-discovered models on the nvidia route. The remaining llm/pi-ai failures reproduce identically on the untouched tree and belong to the parallel-session damage.

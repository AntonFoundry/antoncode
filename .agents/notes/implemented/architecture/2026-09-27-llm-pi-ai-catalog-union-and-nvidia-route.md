# Agent Note: llm-pi-ai catalog union + generalized live refresh; nvidia route

Status: implemented

English

## Problem

Two model-menu failures compounded. First, `resolveRouteModels` served exactly one of three mutually exclusive sources — a configured `models` list, a discovered live listing, or the installed catalog — so a partial list *replaced* the route's catalog and hid models such as `deepseek-v4.1-flash` and `kimi-k3` from the pickers. Second, the live models.dev refresh was hardwired to the `zai` route, so no other route ever learned new provider ids. Separately, the tree did not typecheck: `CredentialRef | undefined` narrowing errors in `llm-openai`/`llm-models-dev`, a missing `unlinkSync` import in `anton-rebuild`, and an `apps/anton-bridge` source file absent from `tsconfig.host.json`'s file list.

## Decision

`resolveRouteModels` now unions: configured/live entries win by id and catalog-only models always remain served (catalog tail keeps `modelOverrides`, which continues to refuse an override that lands nowhere). Naming an override for a model a `models` list also declares stays a loud error — declare the fields on the entry. Live refresh keys off a `MODELS_DEV_ROUTE_PROVIDERS` map (`zai`, `moonshotai`, `deepseek`, `nvidia`), reads one shared models.dev document per settings generation, applies Z.AI's effort spellings only to the zai route (other routes' unknown ids stay neutral), and keeps the endpoint-listing fallback for OpenAI-compatible routes only. Pinned routes still skip refresh unless `liveModelUnion` is enabled; keyless profiles remain catalog-only. A pinned route may opt into joining the live listing with `liveModelUnion` ([2026-09-24-pi-ai-live-model-union.md](2026-09-24-pi-ai-live-model-union.md)). Per-route in-flight promises replace the single-flight `zai` flag.

The `nvidia` route uses pi-ai's builtin endpoint with `apiKeyEnv: NVIDIA_API_KEY`, `api: openai-completions`, `liveModelDiscovery: true`, and `liveModelUnion: true`. Its explicit `z-ai/glm-5.3-flash` model stays first and declares text/image input. At startup the route reads NVIDIA's maintained [LLM API reference](https://docs.api.nvidia.com/nim/reference/llm-apis) and unions its chat-completion model ids with the configured endpoint's `/models` listing, which can omit documented partner models such as `deepseek-ai/deepseek-v4-flash`. This catalog is in memory only and refreshes on mount and settings changes; a failed source keeps the installed catalog. The adapter humanizes provider and model labels without changing ids used for settings or requests. The narrowing fixes preserve the loud `MISSING_CREDENTIAL`/error contract; `request`/`requestResponses` widen their `apiKey` parameter to `string | undefined`, which their bodies already handled.

## Verification

Focused tests cover the NVIDIA reference parser, the document-plus-endpoint union, configured pin precedence, and selector-label formatting. The reference currently documents 55 models under its shared `POST /v1/chat/completions` API; the NVIDIA Build page's “Free Endpoint 38” badge counts models across publishers and includes non-chat services, so it is not the correct source for this chat selector. The endpoint listing remains a supplement for ids the account advertises, while model ids stay unchanged for requests.

# Fix DeepSeek thinking-mode reasoning passback

## Symptom
Turn failed with `invalid_request_error: The reasoning_content in the thinking mode must be passed back to the API` on `deepseek-official` / `deepseek-flash` (V4.1 Flash) with `reasoning_effort: max`.

## Hypothesis under test
`packages/llm/llm-deepseek/src/serialize.ts` replays `reasoning_content` **only** on assistant turns that carry tool calls, and drops it on tool-call-free turns. DeepSeek's thinking mode requires the reasoning to be passed back on every replayed assistant turn it produced reasoning for, so a later request whose history includes such a turn is rejected with 400.

## Investigation
1. Locate the concrete session log for the failed turn and read the assistant messages + the failing request to confirm which replayed assistant message lacked `reasoning_content` and whether it had reasoning in the log at all (distinguishes serializer drop from a lossy history source such as compaction).
2. Check other writers of assistant history for reasoning loss (compaction, projections, retry paths).

## Fix
3. Change the DeepSeek serializer to carry `reasoning_content` on every assistant turn that has reasoning blocks (not just tool-call turns), keeping the `content: ''` rule.
4. Update the unit tests for the new passback rule; add a case that a reasoning+text turn keeps `reasoning_content`.
5. Update `packages/llm/llm-deepseek/README.md` (wire-format notes + Model Experience) and the module JSDoc.
6. Run the focused tests, typecheck, lint for the package; add an Agent Note if the decision is non-trivial; commit.
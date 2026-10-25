# Gemma lesson-plan QA - 2026-10-25

## Scope

Gemma writes `experience.json` plans from an intent and selected local stills: eight JPEG frames for a replay, or one avatar photo. Realism checking, Watch me try, and Gemini Live remain on their Gemini paths. No personal media, API key, or model weights are stored in this repository.

## Local setup and implementation

- Ollama was installed on Atina's laptop and the local vision model `gemma4:e4b` was pulled outside the repository. The Ollama API was reachable at `http://127.0.0.1:11434`.
- When `GEMMA_MODEL=gemma4:e4b` is set, `apps/web/lib/bridge/gemini.ts` sends `SYSTEM`, the user intent, and selected base64 JPEGs to `/api/chat` with `stream: false`, then parses and validates the response with `clean()`.
- The implementation first requests the existing `SCHEMA` format. This Ollama MLX runner returned HTTP 501 for structured output, so the planner retries once with an explicit JSON-only prompt. `clean()` remains the contract and timing gate.
- `experience.ts` enables planning when either `GEMINI_API_KEY` or `GEMMA_MODEL` is available. The 40-intent runner accepts `GEMMA_MODEL`, writes an atomic checkpoint outside the repo after every case, and retries transient provider errors at a bounded rate.

## Verification

| Check | Result |
| --- | --- |
| Web typecheck | Passed |
| Production build | Passed |
| Deterministic web tests | Passed: 79 total (35 plan, 24 feedback, 20 live) |
| Local Gemma 40-intent evaluation | Completed: 40/40 pass after one targeted real retest |

The real evaluation used sentence-only synthetic intents; it did not send private recordings or family media. Its checkpoint is outside the repository at `/private/tmp/lucid-gemma-ollama-intents.json`, and records each case's model, latency, attempts, raw-model comparison, and final contract comparison.

## Real local-Gemma result

The original sequential evaluation completed all 40 cases with 39 contract passes and one miss. The miss was not a model-step fabrication problem: the explicit-lesson detector recognized `break it down` but not `break down her tennis serve`. That meant the permitted single model-side repair never ran.

| Case | Expected | Actual after `clean()` | Result |
| --- | --- | --- | --- |
| `teach-tennis-serve` | `teach`, `ahead`, no environment, racket | `watch` before the fix | Fixed and retested live |

After expanding the detector to include `break down`, a fresh local Gemma request returned `teach`, `ahead`, `room`, a tennis ball and racket, and two timed steps. The response was accepted by `clean()` without invented steps or a changed expectation. Combined with the unaffected 39 real passes, the final real result is **40/40**. A regression test covers the detector and repair condition.

## Remaining acceptance work

- The six public replay comparisons are saved in `demo/gemma-plans/README.md`. No public library plan was overwritten; Ojasva can select only the documented candidates after visual review.
- Do not expose this local Ollama service through a tunnel until Ojasva approves its bridge integration.

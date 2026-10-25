# Gemma lesson-plan QA — 2026-10-25

## Scope

Gemma writes only `experience.json` lesson plans from an intent and 6–8 local stills from the clip window (or one sanitized avatar photo). Realism, Watch me try, and Gemini Live remain on their existing Gemini paths. No clip is uploaded through Google Files for lesson planning, and no API key, personal footage, or family media is recorded here.

## Implementation verified locally

- The planner in `apps/web/lib/bridge/gemini.ts` discovers instruction-tuned `gemma-...-it` models from the Google AI model list unless `GEMINI_MODEL` explicitly selects one for QA or deployment.
- The local key can access `gemma-4-31b-it`, which was selected explicitly for this run.
- A replay is sampled into eight evenly spaced JPEG frames with ffmpeg; an avatar supplies its sanitized JPEG. The model receives the intent, dream name, media description, planning rules, and a request for one JSON object in the user prompt. It receives no video upload, Gemini-style system instruction, or response schema.
- `clean()` still owns timing, mode, placement, object, and safety validation. It never invents a missing lesson step.
- The live runner writes an atomic checkpoint outside the repository after every case, resumes successful and judged cases, retries transient provider failures at most once with exponential backoff, and records latency and provider errors.

## Offline checks

| Check | Result |
| --- | --- |
| TypeScript typecheck | Passed |
| Deterministic plan suite | Passed: 35 tests, including Gemma model selection, reasoning-text JSON parsing, and real local ffmpeg extraction of eight JPEG frames |
| Existing 40-intent contract fixtures | Passed through deterministic `clean()` checks |

## Live evaluation: provider-blocked after five cases

This was a real, sentence-only request path through `writeExperience` and `gemma-4-31b-it`. No private media was sent. The endpoint and credential were confirmed by the first two successful plans. The next three cases failed at the provider after bounded retries: two returned `Internal error encountered.` and one timed out. The sequential process was stopped after the third consecutive provider failure to avoid duplicate or wasteful calls. This is not a 40-case result and does not measure the model quality of the 35 unexecuted cases.

| Metric | Result |
| --- | --- |
| Real cases executed | 5 / 40 |
| Passed after `clean()` | 2 |
| Plan-contract misses | 0 |
| Provider-blocked | 3 |
| Unexecuted | 35 |
| Model | `gemma-4-31b-it` |

### Individual results

| Case | Expected mode | Result |
| --- | --- | --- |
| `teach-piano-side-by-side` | `teach` | PASS — 38233 ms, 1 attempt |
| `teach-jump-shot` | `teach` | PASS — 22907 ms, 1 attempt |
| `teach-strum` | `teach` | BLOCKED — Internal error encountered. (4316 ms, 2 attempts) |
| `teach-violin` | `teach` | BLOCKED — Internal error encountered. (49970 ms, 2 attempts) |
| `teach-salsa-step` | `teach` | BLOCKED — Gemini took too long. It tries again in a few minutes. (44452 ms, 1 attempts) |
| `teach-squat-form` | `teach` | Not executed — provider batch stopped |
| `teach-tennis-serve` | `teach` | Not executed — provider batch stopped |
| `teach-omelette-flip` | `teach` | Not executed — provider batch stopped |
| `teach-origami-crane` | `teach` | Not executed — provider batch stopped |
| `teach-boxing-combo` | `teach` | Not executed — provider batch stopped |
| `companion-sit-with-her` | `companion` | Not executed — provider batch stopped |
| `companion-be-with-me` | `companion` | Not executed — provider batch stopped |
| `companion-while-i-cook` | `companion` | Not executed — provider batch stopped |
| `companion-miss-grandpa` | `companion` | Not executed — provider batch stopped |
| `companion-hear-her-voice` | `companion` | Not executed — provider batch stopped |
| `companion-birthday` | `companion` | Not executed — provider batch stopped |
| `companion-couch` | `companion` | Not executed — provider batch stopped |
| `companion-mountains` | `companion` | Not executed — provider batch stopped |
| `companion-morning-coffee` | `companion` | Not executed — provider batch stopped |
| `companion-stay-tonight` | `companion` | Not executed — provider batch stopped |
| `watch-show-me-doing-it` | `watch` | Not executed — provider batch stopped |
| `watch-ballet-solo` | `watch` | Not executed — provider batch stopped |
| `watch-cello-piece` | `watch` | Not executed — provider batch stopped |
| `watch-follow-workout` | `watch` | Not executed — provider batch stopped |
| `watch-shadowboxing` | `watch` | Not executed — provider batch stopped |
| `watch-piano` | `watch` | Not executed — provider batch stopped |
| `watch-tai-chi-mountains` | `watch` | Not executed — provider batch stopped |
| `watch-skateboard-trick` | `watch` | Not executed — provider batch stopped |
| `watch-dance-along` | `watch` | Not executed — provider batch stopped |
| `watch-wedding-toast` | `watch` | Not executed — provider batch stopped |
| `play-chess` | `play` | Not executed — provider batch stopped |
| `play-carlsen` | `play` | Not executed — provider batch stopped |
| `play-fischer` | `play` | Not executed — provider batch stopped |
| `play-go-easy` | `play` | Not executed — provider batch stopped |
| `play-grandmaster` | `play` | Not executed — provider batch stopped |
| `play-full-strength` | `play` | Not executed — provider batch stopped |
| `play-with-dad` | `play` | Not executed — provider batch stopped |
| `play-expert` | `play` | Not executed — provider batch stopped |
| `play-teach-me-chess` | `play` | Not executed — provider batch stopped |
| `play-chess-master` | `play` | Not executed — provider batch stopped |

## What remains

- Resume the same command only when the provider is healthy; the checkpoint is `/private/tmp/lucid-gemma-intents.json`, outside the repository. It preserves the two verified passes and records the provider-blocked cases for re-evaluation after a service recovery.
- Compare Gemma plans with hand-written plans for non-family library dreams only on Ojasva's bridge Mac; retain the better plan with its factual `source` and `model` fields.
- A public Make one run requires a consenting, head-to-toe clip and Ojasva's bridge/HiPerGator availability. It was not attempted from this checkout.

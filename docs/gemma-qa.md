# Gemma lesson-plan QA — 2026-10-25

## Scope

Gemma writes only `experience.json` lesson plans from an intent and 6–8 local stills from the clip window (or one
sanitized avatar photo). Realism, Watch me try, and Gemini Live remain on their existing Gemini paths. No clip is
uploaded through Google Files for lesson planning, and no API key, personal footage, or family media is recorded here.

## Implementation verified locally

- The planner in `apps/web/lib/bridge/gemini.ts` discovers instruction-tuned `gemma-...-it` models from the Google AI
  model list unless `GEMINI_MODEL` explicitly selects one for QA or deployment.
- The local key's model-list response included `gemma-4-26b-a4b-it` and `gemma-4-31b-it`; the latter is selected as
  newest by default.
- A replay is sampled into eight evenly spaced JPEG frames with ffmpeg; an avatar supplies its sanitized JPEG. The
  model receives the intent, dream name, media description, planning rules, and a request for one JSON object in the
  user prompt. It receives no video upload, Gemini-style system instruction, or response schema.
- `clean()` still owns timing, mode, placement, object, and safety validation. It never invents a missing lesson step.

## Offline checks

| Check | Result |
| --- | --- |
| TypeScript typecheck | Passed |
| Deterministic plan suite | Passed: 35 tests, including Gemma model selection, prompt/JSON parsing, and real local ffmpeg extraction of eight JPEG frames |
| Existing 40-intent contract fixtures | Passed through the deterministic `clean()` checks |

The complete web command (`npm --prefix apps/web test`) also completed its deterministic plan, feedback, and Live
suites successfully (79 tests total). Its final live-intent subcommand could not contact Google from the sandbox:
all 40 cases failed with `fetch failed` before a model response. That sandbox result did not make a billable request.

## Live evaluation attempted

The required 40-sentence evaluation was started once with `GEMINI_MODEL=gemma-4-31b-it`:

```bash
GEMINI_MODEL=gemma-4-31b-it npm --prefix apps/web run test:intents
```

The first direct request did not return after more than the planner's 180-second timeout, and the local runner was
stopped before it could issue another request. There is no score to claim. This is a live service or SDK timeout, not a
successful Gemma plan and not evidence about plan quality. Do not retry the full suite until the model responds to a
single bounded smoke request.

Then, on Ojasva's bridge Mac, use a non-family library dream to compare a Gemma plan with its existing hand-written
plan. Keep only the better plan and retain its `source`/`model` fields; never send a family clip or photo to Gemma.
A complete Make one public-site run also requires Ojasva's bridge and HiPerGator login, so it cannot be verified from
this checkout.

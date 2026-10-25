# Gemini QA — 2026-10-24

## Result

The Gemini integration is implemented on `origin/main`, but it has not yet made a
live request from the bridge.  The bridge has no `GEMINI_API_KEY` in
`apps/web/.env.local`, and this QA machine has no key in its environment.  Do not
claim live Gemini behavior in the Devpost until the live checklist below is
completed and this result is updated with the observed responses and timings.

## Offline verification completed

On this branch, `npm --prefix apps/web run typecheck` and
`npm --prefix apps/web test` passed.  The test run covers:

- 40 intent sentences and 30 contract-cleaning cases for `experience.json`.
- Mocked Gemini feedback, including malformed answers, a quota response,
  privacy rejection, local-location metadata rejection, cleanup, caching and
  rate limits.
- No-key behavior: feedback and Live coaching remain unavailable without
  sending media anywhere.
- Bridge run-status tests.

The deployed home page also returned HTTP 200 on 2026-10-24.  This is only a
reachability check, not phone, camera, microphone, or Gemini verification.

## Actual environment checks (2026-10-24 ET)

These are deliberately separate from the mocked results above.  They made only
read-only HTTP requests and did not upload media or invoke Gemini.

| Check | Result |
| --- | --- |
| Local shell `GEMINI_API_KEY` | Absent (value was never read or printed). |
| Local `apps/web/.env.local` key | Absent (value was never read or printed). |
| `npm --prefix apps/web run test:intents` | Fixture validation passed; it correctly did **not** call Gemini without a key. |
| Deployed `GET /api/live/token` | `200 {"state":"off"}`. |
| Deployed `GET /api/dreams/dance-01/experience` | `200`, ready, but its source says it was hand-written because this bridge has no Gemini key. |
| Deployed `GET /api/dreams/dance-01/realism` | `200 {"state":"off"}`. |
| Deployed `GET /api/dreams/dance-01/feedback` | `200 {"state":"off"}`. |

Conclusion: no real Gemini plan, realism comparison, Watch me try response, or
Live token has been verified yet.  The only integration blocker found is the
missing bridge-Mac key; no repository defect was observed or changed.

## Actual local Gemini run (2026-10-24 ET)

The local ignored `.env.local` now has a non-empty `GEMINI_API_KEY`; its value
was never read, printed, logged, or staged.  `LD_GEMINI_KEY` is not a runtime
variable in this codebase: the bridge and test runner read `GEMINI_API_KEY`.

- Gemini's models endpoint returned HTTP 200 and all three configured planning
  fallbacks were available.
- A bounded text-only `generateContent` call returned HTTP 200 with a normal
  `STOP` response.
- The bridge's exact sentence-only planner passed a smoke test for **"teach me
  this jump shot"** using `gemini-3.8-flash`.
- The subsequent full 40-case run hit real output-quality failures before its
  quota retries made further testing impractical: Gemini returned `watch` for
  **"sit next to me and teach me this piece"** and **"teach me this jump
  shot"**, where the contract and system prompt unambiguously require `teach`.
  It then hit quota backoff while processing **"help me learn this violin
  passage"**.  Duplicate interrupted runners were stopped before they could
  make more requests.

This is not a bad fixture: the system prompt defines those same explicit
teaching phrases as `teach`.  The cleaner intentionally cannot safely turn a
`watch` answer with no steps into a lesson, because that would invent an
invalid lesson plan.  No production logic was changed during QA.  Rerun the
remaining 37 cases after quota resets, ideally with per-case results captured
from a retained terminal session.

## What is ready to test live

The bridge already uses `GEMINI_API_KEY` only on the server and supports:

1. An intent plus its prepared clip/photo becoming a cached `experience.json`.
2. A realism check that compares source media to the rendered preview.
3. Watch me try feedback, which deletes the learner recording after the result.
4. A constrained, single-use Gemini Live token for the lesson coach.

All four have model fallbacks, bounded retries or queues, and user-facing
errors for invalid keys, quota/rate limits, timeouts and malformed model
responses.  The integration excludes family media from realism and attempt
uploads, and the Live key never leaves the bridge.

## Required live checklist

1. Create a key at <https://aistudio.google.com/apikey>; give it to Ojasva in
   person or by AirDrop.  Never put it in Git, a chat, or this file.
2. Ojasva adds `GEMINI_API_KEY=...` to `apps/web/.env.local` on the bridge Mac
   and restarts the web app.
3. On a laptop, run `GEMINI_API_KEY=... npm --prefix apps/web test`; record the
   result of the 40 live intent checks below.
4. From a phone or laptop, create a short, still, head-to-toe clip at
   <https://getluciddreams.vercel.app>, submit it with one sentence, and record
   upload-to-ready time plus whether the generated plan fits the sentence.
5. On an eligible public dream, check Realism, then record a Watch me try
   attempt.  In `dance-01`'s Lesson, use Ask and record whether the microphone
   prompt, response, and stop behavior work.

## Live results

Pending the key and a bridge-Mac test.  Record only non-sensitive summaries:
date/time, dream id, feature, pass/fail, duration, and a short description of
the response.  Do not put source media, API keys, or family details here.

## Local follow-up — 2026-10-25 ET

Google AI Studio showed the default `gemini-3.8-flash` planner above its daily
request limit (24 / 20), while `gemini-3.6-flash` still had capacity. The
production fallback order was left unchanged. Local QA set
`GEMINI_MODEL=gemini-3.6-flash` only for individual commands.

| Check | Result |
| --- | --- |
| Typecheck + deterministic plan, feedback and Live suites | Passed: 75 tests. |
| Text-only planner: `sit next to me and teach me this piece` | Gemini recognized the requested teaching mode and expected placement, but the returned plan did not contain enough valid timed steps for the player. The safety cleaner correctly returned `watch` rather than inventing a lesson. |
| Lesson-plan hardening | Added one bounded model-side repair for an explicit teaching request on a non-chess replay when the first response cannot make a runnable lesson. The repair reuses the actual model/media context; it never synthesizes steps locally. Photos, companions, chess, and ordinary watch requests are excluded. |
| Repair retest | The final plan still downgraded to `watch`; Gemini 3.6 did not produce a valid enough lesson in that sentence-only case. |
| Further diagnostic request | Stopped on `503 UNAVAILABLE` (Gemini reported temporarily high demand). No further live calls were made. |
| Realism, Watch me try, Ask / Gemini Live | Not live-tested in this session: no non-private local dream bundle and a stable model response were available. Their deterministic privacy, cleanup, rate-limit, token, and state tests passed. |
| Full runner in the sandbox | The key-present command reached no external network: all 40 checks failed locally with `fetch failed` before a model response. It made no billable Gemini requests and was not retried. |

The planning repair is a reliability improvement, not a claim that the two
showcase lessons have passed end to end. A real bridge bundle with its source
clip should be tested once Gemini 3.6 is available again; record the final
`experience.json` and duration here without storing media or keys.

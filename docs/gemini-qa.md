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

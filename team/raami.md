# Raami: the product app, the bridge and the Gemini guide

You own the product people touch outside the headset, and the API that connects everything. The bar is
**Apple-level design**: calm, white space, one accent colour, SF Pro / Inter, real content, no gradients-everywhere
or "AI template" look. This is our **Best Design** entry. Read `AGENTS.md` first.

## Your big chunk

| Piece | Done means |
| --- | --- |
| Web app in `apps/web/` (Next.js + TypeScript) | Landing page with the one-line pitch and a hero, "Make a dream" upload flow, the library of dreams, a dream detail page |
| Upload flow | Drop a clip or photo, name it, pick "replay" or "avatar"; checks the clip against the rules in `AGENTS.md` before upload (length, resolution, orientation) and says exactly what to fix |
| Live progress | Polls `GET /api/jobs/:id`; shows the stages (`check`, `views`, `upscale`, `reconstruct`, `export`) with a calm progress bar and ETA |
| Library and detail | Cards with `thumb.jpg`; detail page plays `preview.mp4` (the 360 orbit) and shows the fidelity numbers from `dream.json` |
| The bridge API | A small server on Ojasva's Mac implementing the job API in `AGENTS.md`. Start with a **mock** that serves a sample bundle and fake progress so you, Ian and the demo never wait; Ojasva wires the real HiPerGator calls in |
| Gemini guide (MLH prize) | Gemini watches the source clip and returns: the move's name, its steps with timestamps, and coaching tips. Shown on the detail page and spoken in the headset (Ian plays the audio) |

## Milestones

| When | Done |
| --- | --- |
| Fri 11 PM | Mock bridge running; web app skeleton with landing, upload and library against the mock |
| Sat 10 AM | Upload -> real job -> bundle works through the real bridge (with Ojasva) |
| Sat 8 PM | Polished end to end; Gemini guide working |
| Sun 10 AM | Frozen; screenshots for Devpost to Atina |

## Talk to

- Ojasva: wiring the bridge to HiPerGator, job stages and timings.
- Ian: the library endpoint.
- Atina: she designs the in-headset UI to match your web app, so share your colours, type and components early.
- Atina: copy, screenshots, the demo flow.

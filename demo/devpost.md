# Devpost draft — Lucid Dreams

## Title

Lucid Dreams

## Tagline

Anyone from any video, standing in your room.

## Elevator pitch

Show it anyone. Tell it what you want to do with them.

Lucid Dreams turns a video or photo and a sentence of intent into a life-size person in Meta Quest passthrough. A basketball clip becomes a slowed lesson with the ball and hoop in your room. An approved family memory becomes a quiet companion. A photo avatar can sit across a chessboard while Stockfish plays at a named rating.

## Inspiration

People keep meaningful moments in flat clips and old photos: a relative speaking, a friend teaching a move, a performer from another era. Watching them on a phone keeps them behind glass. We wanted to make those moments feel present while staying honest about the parts a camera never captured.

## What it does

Upload a photo or video, choose what you want to do with that person, and Lucid Dreams creates an experience:

- **Teach:** a replay slows into timed steps, repeats a move, then freezes for your turn.
- **Companion:** an approved photo or video becomes a calm life-size presence, with captions when verified speech is available.
- **Watch:** a photoreal 4D Gaussian replay plays at normal or slowed speed in your room.
- **Play:** a chess scene uses Stockfish at a requested strength. “Fischer” and “Carlsen” mean engine ratings only; they are labelled “Not affiliated.”

The Quest and WebXR players place people on the real floor at life size. A Reality check shows what the original camera saw versus generated detail, instead of passing inferred backs and sides off as recorded fact.

## How we built it

Our replay pipeline accepts a short, sharp, full-body clip. 4DAnyone generates consistent views around the moving person. We reconstruct those views as a sequence of 3D Gaussians, export a dream bundle, and stream the compact representation to WebXR and Quest. The player keeps the person at real scale, runs lesson timing from `experience.json`, and can show source-checked captions beside them.

For avatars, DiGS-Avatar turns one photo into a rigged Gaussian person. Our research experiment fine-tunes that starting avatar on 4DAnyone’s generated views, then compares the one-photo and fine-tuned outputs on held-out views.

We also built two local quality tools:

- A Whisper.cpp caption pipeline that uses word timestamps, rejects silence hallucinations, and writes constrained WebVTT captions without changing the bundle clock.
- A manual old-footage restoration tool that deinterlaces, lightly denoises and runs Real-ESRGAN 4× upscaling while preserving source timing, display aspect and audio. It deliberately avoids face-restoration models because identity matters more than cosmetic smoothness.

## Recent technology

The core technology is 4DAnyone, made public in August 2026. It turns one casual video into consistent multi-view video, which makes a single clip usable for 4D reconstruction. DiGS-Avatar, released in June 2026, provides the recent one-photo avatar foundation. We use Gemini to turn the user’s intent and clip into a structured experience plan that both players can run.

## Challenges we ran into

- **Fidelity is a product requirement.** Blur, bad hands and invented texture are much more visible when a person is standing 1.5 m away. We preserve high-quality source clips, measure held-out reconstruction views, and make unseen content visible.
- **Old footage has tradeoffs.** Our synthetic restoration test raised SSIM and edge sharpness but lowered PSNR and added invented texture. That is not enough evidence to turn restoration on automatically, so it remains manual until matched archival and real-person A/B reconstruction tests support it.
- **One input must serve multiple players.** We defined a compact dream bundle with timing, bounds, reality information, captions, experience plans and optional props that WebXR and Quest can both run.
- **Consent cannot be an afterthought.** We built an explicit consent register and keep raw media and written evidence outside the public repository. Public figures are sourced, labelled and never given cloned voices.

## Measured results

Add only after the final reports are reviewed:

| Measurement | Final value | Evidence |
| --- | --- | --- |
| Replay PSNR / SSIM / LPIPS on held-out views | [pending] | `recon-*.json` from matched final run |
| Render sharpness | [pending] | matched source/render analysis |
| Seen fraction | [pending] | final `dream.json` |
| Processing time / clip length | [pending] | job status and final run record |
| Restoration A/B | [pending] | matched Keaton/Baker + consenting-person comparison |

## What’s next

We will finish real Quest testing, run matched restoration/reconstruction A/B experiments, improve hands and fast-motion fidelity, and expand consented coaching and companion experiences. We will not enable automatic restoration until that evidence shows it helps more than it harms.

## Built with

4DAnyone, DiGS-Avatar, Gemini, gsplat, Spark, three.js, Unity Gaussian Splatting, NLF, rembg, GVHMR, BiRefNet, SMPL-X, whisper.cpp, Real-ESRGAN, FFmpeg and Stockfish. Full source, attribution and license details: [demo/credits.md](credits.md).

## Tracks

- Overall
- Best AI Hack
- Best Design
- Best Social Impact
- MLH Best Use of Gemini
- MLH Best Open Source

## Submission checklist

- [ ] Replace every `[pending]` value only with a verified final report.
- [ ] Add the public repository URL and final demo-video URL.
- [ ] Confirm roster names, roles and consented media scope.
- [ ] Check every source against [credits.md](credits.md), including final Pexels URLs and CC BY-SA attribution.
- [ ] Keep public-figure labels and the seen-versus-imagined explanation in the final description/video.

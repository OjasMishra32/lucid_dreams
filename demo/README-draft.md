# Lucid Dreams

> Anyone from any video, standing in your room.

**Show it anyone. Tell it what you want to do with them.** Lucid Dreams turns a video or photo and a sentence of intent into a life-size experience in Meta Quest passthrough and WebXR.

> Final README hero: add a short, consented demo GIF or video still here. Do not add source clips, family media, model weights, Gaussian files or private consent evidence to this repository.

## What you can do

- Turn a short full-body clip into a photoreal 4D Gaussian replay on your real floor.
- Ask a replay to teach a movement. It slows and repeats each step, then holds the last pose for your turn.
- Make an approved photo or video into a companion experience.
- Read quiet, synchronized captions beside a speaking person.
- Switch on Reality check to tint source-unseen detail blue.
- Play a hand-tracked chess side experience against Stockfish. Named chess legends are engine ratings, labelled “Not affiliated,” never the real person.

## How it works

```text
photo or video + intent
        │
        ▼
web upload / Mac drop folder
        │
        ▼
4DAnyone multi-view video ──► 4D Gaussian reconstruction ──► dream bundle
                                                     │
               ┌─────────────────────────────────────┴────────────────────────────────────┐
               ▼                                                                          ▼
        Quest passthrough                                                          WebXR viewer
```

For a replay, 4DAnyone creates consistent views of one moving person. Our pipeline reconstructs and exports those views as frame-by-frame Gaussian splats. The final dream bundle carries timing, real-world bounds, audio, optional captions, optional props, and a plan for the experience. The Quest and WebXR players place that shared bundle at life size on the real floor.

For avatars, DiGS-Avatar provides a rigged Gaussian person from one photo. We fine-tune that starting point on 4DAnyone’s generated views and compare it with the one-photo result on held-out views.

## Honesty, consent and fidelity

The camera did not see every side of a person. Lucid Dreams marks source-unseen Gaussian detail with the Reality check instead of presenting it as recorded fact.

We use photoreal likenesses and voices only with permission for the planned use. Raw media, model weights and written consent evidence remain outside this public repository. Public-figure sources are credited, labelled for demonstration only, never given cloned voices, and never presented as endorsements.

We report PSNR, SSIM and LPIPS on held-out views plus render sharpness. Final values belong here only after their reports are verified:

| Metric | Final replay |
| --- | --- |
| PSNR | [pending verified run] |
| SSIM | [pending verified run] |
| LPIPS | [pending verified run] |
| Seen fraction | [pending verified run] |
| Processing time | [pending verified run] |

## Local development

The repository includes a tiny synthetic dream bundle for player development. It does not represent a real person or final fidelity.

```sh
# WebXR viewer
npm --prefix apps/webxr install
npm --prefix apps/webxr run dev

# Product web app and bridge
npm --prefix apps/web install
npm --prefix apps/web run dev

# Synthetic pipeline input (run in the pipeline environment, which includes NumPy)
PYTHONPATH=pipeline python3 -m lucid.synthetic --help
```

The bridge serves a sample bundle until the GPU pipeline completes a real run. The lightweight local caption and restoration
tools below use only Python's standard library; the synthetic generator and reconstruction stages run in the pipeline
environment. HiPerGator GPU jobs are submitted only by Ojasva.

### Captions

Atina’s caption tool runs on a completed, consented bundle. It prefers `voice.m4a`, then `audio.m4a`, preserves the bundle timeline, and writes `captions.vtt` plus the optional manifest field.

```sh
PYTHONPATH=pipeline python3 -m lucid.captions /absolute/path/to/dreams/my-dream \
  --model /absolute/private/path/ggml-large-v3-turbo.bin
```

Install `ffmpeg` and `whisper.cpp` first. Download the Whisper model outside this repository. The detailed runbook and acceptance conditions are in [demo/README.md](README.md).

### Manual old-footage restoration

Restoration is deliberately manual while its real-footage A/B evaluation is pending. It deinterlaces, lightly denoises, uses Real-ESRGAN x4plus, and verifies frame timing, display aspect and original audio before publishing a new output.

```sh
PYTHONPATH=pipeline python3 -m lucid.restore /private/input.mp4 /private/restored.mp4 \
  --esrgan /private/tools/realesrgan-ncnn-vulkan \
  --models /private/tools/models
```

It never overwrites the source and does not alter shared clip preparation. See [demo/README.md](README.md) for supported media, failure behavior and the current mixed synthetic A/B result.

## Credits

Lucid Dreams builds on recent research and open-source software including 4DAnyone, DiGS-Avatar, gsplat, Spark, three.js, Unity Gaussian Splatting, NLF, rembg, GVHMR, BiRefNet, SMPL-X, whisper.cpp, Real-ESRGAN, FFmpeg and Stockfish. Source media, licenses and required attribution are tracked in [demo/credits.md](credits.md).

## Team

Ojasva — pipeline and GPU jobs · Vishal — avatars · Ian — Quest · Raami — product web app and Gemini bridge · Atina — story, data, demo, captions and restoration evaluation.

## License

Lucid Dreams is released under the [MIT License](../LICENSE). Third-party models, code and source media retain their own licenses and terms.

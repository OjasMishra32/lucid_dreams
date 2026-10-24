# Lucid Dreams

> Anyone from any video, standing in your room.

**Give it any photo or video, and one sentence of what you want to do with that person. They're in your room doing it
with you.** A guitar teacher's clip and "teach me this strum" becomes a lesson. A grandparent's photo and "I just want to
sit with her" becomes a quiet companion. A shooter's clip and "teach me this jump shot" puts them on your floor with the
ball and a hoop. Lucid Dreams turns one ordinary video into a photoreal, life-size 3D person in Meta Quest 3S
passthrough (and in any WebXR browser), moving exactly like the footage, and lets you walk around them, slow them down
and learn from them.

Built in 48 hours at Gator Hack V (UF AI Days 2026). MIT licensed.

## Five moments

| | Moment | The sentence | What happens |
| --- | --- | --- | --- |
| 1 | **Piano lesson, side by side** | "sit next to me and teach me this piece" | A piano teacher sits at your right, plays each phrase slowly, then waits for your turn. |
| 2 | **A jump shot in your driveway** | "teach me this jump shot" | The shooter on your floor with the real ball and a regulation hoop; each step slowed, then your turn. |
| 3 | **Chess with the legends** | "play chess with me" | Fischer or Carlsen sits across a real-size board and moves their own pieces. They are always labelled as the engine at their peak rating, never the real person. |
| 4 | **Someone you've lost** | "I just want to sit with her" | A family member from a home video or photo, with their own voice from where they sit and their words as captions. Only with the family's written consent. |
| 5 | **You, perfected** | "show me doing it" | Your own photo becomes an avatar that performs someone else's move. |

Sources and licenses for every person shown are in [demo/credits.md](demo/credits.md).

## How it works

```text
 a video or photo + one sentence
        │
        ▼
 web app (upload, 5-second window, consent) ──► Gemini writes the plan: experience.json
        │
        ▼
 HiPerGator (12 GPUs per person)
   1. check the clip: one person, head to toe, still camera
   2. 4DAnyone: one video ──► 24-48 synchronized views all the way around, with cameras
   3. 4D Gaussian reconstruction, frame by frame (each frame warm-started from the last)
   4. export a dream bundle: Gaussian frames, "seen vs imagined" frames, props, voice, captions
        │
        ├──► photo? DiGS-Avatar ──► fine-tuned on 4DAnyone's views ──► a rigged person that can do any move
        ▼
 Meta Quest 3S (Unity) or any WebXR browser: life size on your real floor, in passthrough
```

1. **Ask.** The [web app](apps/web) takes a clip or photo and your sentence, checks the clip in the browser (one
   person, whole body), and lets you pick the five seconds that matter. Gemini watches the move and writes the plan,
   `experience.json`: the steps of a lesson, where the person stands, the place around them.
2. **See all the way round.** [4DAnyone](https://github.com/ant-research/4DAnyone) turns one casual video into
   consistent 360-degree multi-view video, so a single phone clip becomes enough to rebuild a whole person.
3. **Rebuild in 3D.** Our pipeline ([`pipeline/`](pipeline)) reconstructs a 3D Gaussian person per frame with
   [gsplat](https://github.com/nerfstudio-project/gsplat), warm-starting each frame from the one before.
4. **Bundle it.** Each dream exports at real size, feet on the floor: full-quality PLY frames and compact SPZ frames,
   reality frames that tint whatever the camera never saw blue, the ball's real path and a hoop, the isolated voice
   and its captions.
5. **Stand them in your room.** The [Quest app](apps/quest) and the [WebXR viewer](apps/webxr) play the bundle life
   size on your real floor. You use bare hands: pinch to pause, grab to move them, push fingertip buttons, and your
   real hands stay in front of them. Lessons slow each step and wait for your turn, captions float in front of them,
   and a 360-degree place (concert hall, court, gym, ring) can replace your room.

**Avatars** ([`avatars/`](avatars)): one photo becomes a photoreal, rigged Gaussian person with
[DiGS-Avatar](https://github.com/KLMAV-CUC/DiGS-Avatar). We fine-tune it on 4DAnyone's generated views of a video, so
a single clip becomes a person who can perform any motion. Both players skin it on the GPU every frame.

### Why it's new

The core of Lucid Dreams did not exist a year ago. **4DAnyone** (Ant Research, SIGGRAPH Asia 2026) was released in
August 2026, and **DiGS-Avatar** (ECCV 2026) in June 2026. Our research contribution is the combination: fine-tuning a
one-photo avatar on 4DAnyone's generated views, so one video yields a person who can do anything, with fidelity
measured before and after.

## Measured, not claimed

| | Result |
| --- | --- |
| Held-out views, real clips (two Pexels jump shots) | **PSNR 26-28 dB, SSIM 0.96-0.97** |
| Held-out views, synthetic test person | PSNR 32.5 dB, SSIM 0.98 |
| Size of a replay | about **285,000 Gaussians per frame**, 121 frames (about 5 s at 25 fps) |
| Reconstruction speed | about 62 s per frame warm-started (4 min cold) on one NVIDIA B200 or RTX PRO 6000; 12 GPUs per person |
| First avatars from licensed photos | Bobby Fischer 1.87 m (38% of him seen in the photo), Magnus Carlsen 1.87 m (34% seen) |
| Quest avatar skinning vs the reference | positions within 0.001 mm of `avatars/lucid_avatars/skinning.py` |

Every dream reports how much of the person the camera really saw. LPIPS, the avatar fine-tune before/after table and
frame rate on the Quest 3S are being measured and will be added here when verified.

## Honesty, consent and fidelity

The camera never sees every side of a person. **Reality check** shows exactly what was imagined: it tints every
Gaussian the source never saw blue and says what share was really seen. We never present generated detail as
recorded.

Photoreal likenesses and voices are used only with permission for the planned use. Raw media, model weights and
written consent stay out of this public repository. Public figures appear for the demo only, from real footage or
freely licensed photos: they are always labelled, never given a cloned voice or words written for them, and never
presented as endorsing anything. Tips in a lesson are read by the device's voice, never the person's.

## Run it

Each app has its own README with details.

**Web app and bridge** ([apps/web](apps/web)), port 5170:

```bash
npm --prefix apps/web install
npm --prefix apps/web run dev            # mock jobs and the sample dream; open http://<this Mac>:5170
npm --prefix apps/web run demo           # real HiPerGator jobs (Ojasva's Mac); Gemini needs GEMINI_API_KEY in apps/web/.env.local
```

**WebXR viewer** ([apps/webxr](apps/webxr)), port 5180, in the Quest browser or on a laptop:

```bash
npm --prefix apps/webxr install
npm --prefix apps/webxr run dev          # https://<this Mac's IP>:5180 (self-signed certificate) for the Quest browser
```

**Quest app** ([apps/quest](apps/quest)): Unity 6000.6 with Android Build Support. Open `apps/quest`, run
**Lucid Dreams > Set Up Project**, then **Build And Run** with the Quest plugged in. Point it at the bridge once:

```bash
adb shell "echo http://<mac-ip>:5170 > /sdcard/Android/data/com.luciddreams.quest/files/bridge.txt"
```

**Pipeline** ([pipeline](pipeline)): GPU jobs run on UF's HiPerGator. From the Mac that holds the connection:

```bash
python3 pipeline/runner/lucid_runner.py submit clip.mp4 --name "Jump shot"
python3 pipeline/runner/lucid_runner.py status <id>
python3 pipeline/runner/lucid_runner.py fetch <id>
```

**Tests:**

```bash
PYTHONPATH=pipeline python3 -m unittest discover -s pipeline/tests -v     # captions, restoration, props export (needs numpy)
cd avatars && uv run pytest                                               # motion, skinning, bundles, idle, ball path
```

The Quest app has headless checks (`HandsCheck`, `PlaybackCheck`) that drive the real scene with simulated hands; see
[apps/quest/README.md](apps/quest/README.md). A tiny synthetic dream in [`samples/synthetic-test`](samples/synthetic-test)
lets every player run without a GPU. The caption and old-footage restoration tools are documented in
[demo/README.md](demo/README.md).

## Repository

```text
AGENTS.md      the plan, the shared contracts (dream bundle, job API, experience, props) and the build log
team/          one brief per person
apps/web/      the website (home, library, make a dream) and the job bridge (Next.js), Gemini plan
apps/webxr/    WebXR viewer and chess (three.js + Spark)
apps/quest/    Quest 3S app (Unity, OpenXR, Unity Gaussians)
pipeline/      reconstruction, export, captions, restoration (Python), HiPerGator jobs, the Mac runner
avatars/       DiGS-Avatar fitting, fine-tuning, motion, skinning
demo/          showcase, credits, consent process, Devpost and video drafts
samples/       a tiny synthetic dream bundle for development
```

## Credits

Lucid Dreams stands on recent research and open source: [4DAnyone](https://github.com/ant-research/4DAnyone),
[DiGS-Avatar](https://github.com/KLMAV-CUC/DiGS-Avatar), [gsplat](https://github.com/nerfstudio-project/gsplat),
[Spark](https://github.com/sparkjsdev/spark), [three.js](https://github.com/mrdoob/three.js),
[Unity Gaussians](https://github.com/ninjamode/Unity-VR-Gaussian-Splatting) (after Aras Pranckevičius's
[UnityGaussianSplatting](https://github.com/aras-p/UnityGaussianSplatting)), [GVHMR](https://github.com/zju3dv/GVHMR),
[NLF](https://github.com/isarandi/nlf), [SMPL-X](https://smpl-x.is.tue.mpg.de/), DINOv3, BiRefNet, rembg,
[whisper.cpp](https://github.com/ggml-org/whisper.cpp), Demucs, Real-ESRGAN, [Stockfish](https://github.com/official-stockfish/Stockfish),
Gemini, and CC0 places and objects from [Poly Haven](https://polyhaven.com). Every source, person, model and library,
with its link and license (including the non-commercial and copyleft terms some carry), is in
**[demo/credits.md](demo/credits.md)**.

## Team

Ojasva (pipeline and HiPerGator), Vishal (avatars), Ian (Quest app), Raami (web app, bridge and Gemini), Atina (story,
consent, captions, restoration and the in-headset design).

## License

[MIT](LICENSE) for everything we wrote. Third-party models, code and media keep their own licenses and terms, listed
in [demo/credits.md](demo/credits.md).

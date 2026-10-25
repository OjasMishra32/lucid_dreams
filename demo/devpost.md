# Devpost: Lucid Dreams

The submission text as it is in the Devpost draft (run through Clever Humanizer, Clear & Structured, then facts, labels, grammar and equations fixed by hand). Written to the judging criteria (impact, technical execution, design and usability, presentation) and the theme (what the recent tech does, the difficulties, why it's recent).

## Name

Lucid Dreams

## Tagline / elevator pitch (under 200 characters)

Turn any video or photo into a photoreal, life-size person in your Meta Quest. Learn their move, play them at chess, or talk to them.

## Story (Devpost's "About the project", Markdown)

## Inspiration

Most of the people we care about live in our camera rolls. Whether they're telling a story in Vietnamese, showing off a move, or hitting a shot we've watched a hundred times, they're six inches tall on our phones. We wanted to be in the same room with them, walk around them, learn from them and talk to them.

## What it does

Lucid Dreams takes a video or a couple of photos, plus one sentence about what you want to do with that person, and creates a photoreal, life-size 3D version of them. They stand in your room in Meta Quest passthrough, and everything runs from one link in the Quest browser.

**Learn:** Watch a dancer, a golfer, a tai chi form or a guitarist at real size. Lesson mode breaks the move into parts, slows them down and repeats them, then pauses so you can have a go. Follow along places glowing markers where your head and wrists should be, based on the clip's own 3D body joints.

**Play:** Play chess against photoreal Bobby Fischer and Magnus Carlsen likenesses who think, reach across the board, move their pieces, press the clock and shake your hand (Stockfish at each one's peak rating; not affiliated; they never speak). Play tennis against a Roger Federer likeness with full rules (an AI opponent, not affiliated). Shoot around with LeBron: hit your own shot, then pass him the ball and he catches it and shoots with his real release (demo footage, not affiliated).

**Court Side:** Step inside a real NBA play, rebuilt in 3D at real size. Freeze it mid-air with the ball in the air and walk around the players, then press play (real footage, not affiliated with the NBA or the players).

**Talk:** A photoreal Vishal, made from a 16-second video of him turning around, answers out loud in his cloned voice. Ian's grandma answers in Vietnamese with an English caption underneath. They both agreed to this, and every reply is labeled AI voice.

**Reality check:** With one tap, everything the camera never saw turns blue, and you see how much of the person was really seen (43 to 54% on our replays). We never pass generated detail off as real.

## Fresh off the frontier

The heart of this project is 4DAnyone, released by Ant Research in August 2026 and published at SIGGRAPH Asia 2026. A camera only ever sees one side of a person, so reconstructing someone in 3D usually takes a ring of synchronized cameras. 4DAnyone creates that ring from one casual video: 48 views of the person as they move, consistent across time and angles. That's what lets us build a person from a clip on a phone. Our avatars use two newer models: LHM++ (March 2026) creates a rigged, animatable Gaussian body from a few photos, and UIKA (CVPR 2026) creates a head from a set of photos.

## How we built it

**Clip to 48 cameras:** The browser validates the clip with MediaPipe pose (one person, head to toe) and selects the best 5 seconds. 4DAnyone turns it into 48 synchronized views in three rings of 16 cameras: 121 frames at 25 fps, with every camera's intrinsics and pose.

**4D Gaussian fitting:** On UF's HiPerGator supercomputer, we fit 3D Gaussians frame by frame with gsplat, using 12 NVIDIA B200 GPUs per person and one chunk of frames per GPU. The first frame takes 7,000 Adam steps. Every later frame starts from the previous one and takes 1,500 (about a minute). The loss is

$$\mathcal{L} = 0.8\,\lVert \hat I - I \rVert_1 + 0.2\,\big(1 - \mathrm{SSIM}(\hat I, I)\big) + 0.1\,\lVert \hat A - A \rVert_1 + \mathcal{L}_{\text{reg}}$$

where Â is the rendered silhouette and the last term holds small penalties on opacity, scale and stretch. Each frame ends up with about 290,000 Gaussians. The real video frame is added as one more camera, but it only counts where it agrees with the generated views.

**Export:** Every frame is exported as SPZ (about 10x smaller than PLY), plus a Reality check copy in which every Gaussian the real camera couldn't see is tinted blue. GVHMR's body fit gives 22 joints per frame in the person's own space. The real ball is tracked in 3D: a candidate must be orange all the way around, stay clear of every limb, move less than 15 m/s between frames, and fall whenever it leaves the hands.

**Animated avatars:** LHM++ creates a rigged SMPL-X body from 8 to 16 photos, or from the 14 sharpest frames of a phone video. UIKA renders the head from 91 views, and we distill those renders into new, opaque Gaussians on the body's own head, so nothing is pasted on. Then we add blinks and a 20-second living idle. The browser poses all of it live with dual-quaternion skinning.

**Lesson plans:** Your sentence and eight frames of the clip become `experience.json`: the steps, their speed and repeats, and where the person stands. Gemma 4 (E4B) writes it locally through Ollama, so the clip never leaves the laptop (branch `atina/gemma-planner`). The lessons in the live library use hand-written plans.

**Headset:** A WebXR app built with three.js and Spark runs in the Quest browser with hand tracking only: a palm-up menu, world anchors, and nothing moves unless you press a button. Spark sorts the Gaussians and blends them front to back:

$$C = \sum_i c_i\,\alpha_i \prod_{j<i} (1 - \alpha_j)$$

Splatting is limited by fill rate, because every Gaussian is drawn as a screen quad, faint ones included:

$$N_{\text{px}} = \sum_i 4k^2\,\sigma_{1i}\,\sigma_{2i}\left(\frac{f}{z_i}\right)^2$$

Our jump shot at 1.8 m comes to 115 million shaded pixels per eye per frame, with up to about 4,900 layers on a single point. The headset keeps the 160,000 Gaussians that contribute most (82 million pixels) and renders at 70%. When frames run late, a governor shrinks the splats, skips faint Gaussians and adds foveation (34 million pixels at its lowest level).

**Talk:** Whisper transcribes what you say, gpt-4o-mini writes a short reply as that person from a few notes about them (no made-up memories), and ElevenLabs speaks it in their cloned voice. The median time from question to answer is 3.1 seconds (1.5 to hear, 1.0 to write, 0.5 to speak) over 11 real tries.

**Games:** The chess legends reach with two-bone arm IK. A checker replays about 75,000 frames per legend, and nothing goes more than 5 mm into the board, a piece, the clock or their own body. Tennis simulates drag, Magnus lift and a grass bounce with spin-dependent friction at 240 Hz, and Federer's AI reads the ball with the same model.

**Website:** One scrolling Next.js page. The dancer renders live with Spark, the Quest 3S is the real headset model, the pipeline is animated with Vishal's real data, and the math is typeset with KaTeX next to live visuals you can drag.

## Challenges we ran into

**Phantom limbs:** 4DAnyone's generated person and the real person in the video are a few centimeters apart, and training on both gave people a second pair of shoes. Removing stray Gaussians couldn't fix it, because the phantom limbs sat inside every silhouette. We fixed it during fitting instead: each frame aligns the real camera to the generated person, so real pixels only count where the two agree. Spill outside the person dropped from 2.3% to 0.4%, and view PSNR went up 0.5 to 2.1 dB.

**Fill rate:** LeBron ran at about 4 fps in the headset when you looked straight at him. The fill-rate math above explains why, and it set our budget, resolution and governor.

**Hands only:** In our first real Quest session, the chess board kept moving whenever someone held a pinch in mid-air. We rebuilt every control around a palm-up menu and world anchors.

**Faces:** From a single photo, the legends had uncanny faces. Many photos plus a distilled head fixed most of it.

**Infrastructure:** At 2 AM we had 14 GB left of the lab's 5 TB quota, and the new Blackwell GPUs needed six fixes before the avatar stack would run.

## Design and usability

Everything runs from one link, with nothing to install. In the headset, one palm menu works everywhere and no controllers are needed. Dreams play straight through, and Lesson mode is one tap away. Everything generated is labeled: the Reality check shows what was imagined, and every reply says AI voice. Captions appear next to the person, with English under Vietnamese.

## Accomplishments that we're proud of

We turned a 16-second phone video into a 1.88 m Vishal you can stand next to and talk to. The chess legends move like real people and shake your hand, and nothing passes through the pieces. Tennis has real rules and real ball physics. Our replays reach 26.0 to 31.9 dB PSNR and 0.963 to 0.982 SSIM against the views they were fit to. And the whole pipeline ran on real footage in one weekend.

## What we learned

Quality came from making the data agree, more than from tweaking the optimizer. Speed in a headset depends on how many pixels you cover. And showing people what was imagined helped them trust what was real.

## Limitations

We haven't measured the frame rate on the Quest itself yet. 4DAnyone needs a still camera and the whole body in frame. The legends' faces are still soft up close. Everything behind the person is generated, which is why the Reality check exists.

## What's next for Lucid Dreams

Measure and lock 72 fps on the Quest, shorten the time it takes to get someone into your room, and bring on more families who want to be with someone again.

## Built with

4danyone, lhm++, uika, gvhmr, gsplat, gaussian-splatting, spark, pytorch, python, gemma, ollama, three.js, webxr, typescript, next.js, react, unity, openxr, meta-quest, mediapipe, whisper, openai, elevenlabs, stockfish, katex, hipergator, vercel, cloudflare

## Try it out links

- Website: https://getluciddreams.vercel.app
- In the headset (Quest browser): https://getluciddreams.vercel.app/xr/
- Code (MIT): https://github.com/OjasMishra32/lucid_dreams

## Still to add on Devpost

- Demo video link (3 minutes max).
- Gallery images.
- Teammates, by Devpost invite.
- Sponsor prizes on Devpost: Best Open Source Project (MLH). Best Use of Gemma: Gemma 4 writes the lesson plans locally, but that code is on the `atina/gemma-planner` branch, not main. Not Twinly.
- Gallery, in order (`~/Downloads/lucid-video/devpost/`): 01 thumbnail, 02 learn, 03 chess, 04 tennis and LeBron, 05 Court Side, 06 Talk, 07 Ian's grandma, 08 how it works, 09 the headset, 10 fresh off the frontier.

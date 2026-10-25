# Devpost: Lucid Dreams

The submission text, as it goes on Devpost (run through Clever Humanizer, then facts and grammar fixed by hand).

## Name

Lucid Dreams

## Tagline / elevator pitch (under 200 characters)

Turn any video or photo into a photoreal, life-size person in your Meta Quest. Learn their move, play them at chess, or talk to them.

## Story (Devpost's "About the project", Markdown)

## Inspiration

Some of the people who mean the most to us live on our phones: a grandma telling a story in Vietnamese, a friend showing off a dance move, a perfect jump shot. On a phone screen they're six inches tall. We wanted to be right there next to them, walk around them, and do things with them.

## What it does

Give Lucid Dreams a video or a few photos and one sentence about what you want to do with that person. They appear in your room at their real size, in Meta Quest passthrough. It all runs from one link in the Quest browser.

**Learn.** Watch a dancer, a golfer, a tai chi form or a guitarist at life size. Turn on Lesson mode and each move breaks into steps that slow down, repeat, then pause for your turn. Follow along puts glowing targets where your head and hands should go.

**Play.** Play chess against Bobby Fischer and Magnus Carlsen likenesses. They think, reach across the board, move their own pieces, press the clock and shake your hand. (Stockfish plays at each one's peak rating. Not affiliated. They never speak.) Play tennis against a Roger Federer likeness (an AI opponent, not affiliated) with full scoring. Pass LeBron a basketball (demo footage, not affiliated) and he'll catch it and shoot.

**Talk.** A photoreal Vishal, made from 16 seconds of video of him turning around, answers your questions in his own cloned voice. Ian's grandma answers in Vietnamese with English captions. Both said yes, and every reply is labeled AI voice.

**Reality check.** One tap turns everything the camera couldn't see blue and shows how much was really seen (43 to 54% on our replays).

## How we built it

**Fresh off the frontier.** 4DAnyone (Ant Research, public August 2026) is what makes one phone video enough: it turns a single clip into 48 views that stay consistent all the way around a moving person. LHM++ (March 2026) and UIKA (CVPR 2026) build animatable bodies and heads from regular photos.

**Replays.** The browser checks the clip with MediaPipe (one person, head to toe) and picks the best 5 seconds. 4DAnyone turns it into 48 synced views, 121 frames at 25 fps. On UF's HiPerGator we fit 4D Gaussians with gsplat on 12 B200 GPUs per person. The first frame trains for 7,000 Adam steps, and each next frame starts from the last one and takes 1,500, about a minute. The loss is 0.8 L1 + 0.2 (1 − SSIM) + 0.1 silhouette, plus small penalties on opacity, size and stretch. Each frame ends up around 290k Gaussians. We export SPZ frames (about 10x smaller than PLY), a Reality check copy, the body's joints from GVHMR, and the real ball tracked in 3D with a regulation hoop.

**Avatars.** LHM++ builds a rigged SMPL-X Gaussian body from 8 to 16 photos or the sharpest frames of a phone clip. UIKA builds the head, and we distill it into new, opaque Gaussians on the body's head. Then come blinks and a 20-second living idle. The browser skins it all in real time with dual quaternions.

**Talk.** Whisper listens, gpt-4o-mini writes a short reply as that person (no made-up memories), and ElevenLabs speaks it in their cloned voice. Median time from question to answer: 3.1 s over 11 real tries.

**Playback.** A WebXR app built on three.js and Spark runs inside the Quest browser with hand tracking only. A palm-up menu and world anchors keep everything where you put it. There's also a native Unity app for Quest. The website is Next.js and shows our math with a live visual for each part.

## Challenges we ran into

**Ghost limbs.** 4DAnyone's generated person and the real person in the video sit a few centimeters apart. Training on both gave people an extra pair of shoes. Now the real frame only counts where it agrees with the views. Stray opacity around the jump shot dropped from 2.3% to 0.4%, and view PSNR went up 0.5 to 2.1 dB.

**Splats are pixel hungry.** Every Gaussian is drawn as a quad, even faint ones, so one person can shade over 100 million pixels per eye per frame. On the headset we keep the 160k Gaussians that add the most, render at 70%, and a governor shrinks splats when frames run late.

**Hands.** In our first real Quest session, a long pinch in mid-air kept moving the chess board. We rebuilt every control around a palm menu and anchors.

**Faces.** From a single photo, the legends had uncanny faces. Many photos plus a distilled head raised Fischer's face match from 0.34 to 0.53.

**Infrastructure.** At 2 AM we were down to 14 GB of the lab's 5 TB quota, and the Blackwell GPUs needed six fixes before the avatar stack would run.

## Accomplishments that we're proud of

- We turned a 16-second phone video into a 1.88 m Vishal you can stand next to and talk to.
- Our replays reach 26 to 32 dB PSNR and 0.96 to 0.98 SSIM against the views they were fit to.
- The chess players' hands never go more than 5 mm into a piece, the board or themselves, checked over about 75,000 frames each.
- Tennis has real rules and ball physics at 240 Hz: drag, Magnus lift from spin, and a grass bounce.
- One link runs the website and the headset.

## What we learned

Quality came from getting the data to agree, more than from tuning the optimizer. Speed on a headset comes down to how many pixels you cover. And showing people what was imagined made them trust what was real.

## What's next for Lucid Dreams

Measure frame rate on the Quest itself, cut the wait from upload to room, and bring in more families who want to stand next to someone again.

## Built with

4danyone, lhm++, uika, gvhmr, gsplat, gaussian-splatting, pytorch, python, three.js, webxr, typescript, next.js, react, unity, openxr, meta-quest, mediapipe, whisper, openai, elevenlabs, stockfish, katex, hipergator, vercel, cloudflare

## Try it out links

- Website: https://getluciddreams.vercel.app
- In the headset (Quest browser): https://getluciddreams.vercel.app/xr/
- Code (MIT): https://github.com/OjasMishra32/lucid_dreams

## Still to add on Devpost

- Demo video link (3 minutes max).
- Gallery images.
- Teammates, by Devpost invite.
- Sponsor prizes on Devpost: Best Open Source Project (MLH) is ticked. The MLH one is Best Use of Gemma, not Gemini, and we do not use Gemma. Not Twinly.

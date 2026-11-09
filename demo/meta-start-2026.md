# Meta VR Start Developer Competition 2026: Lucid Dreams

Draft answers for https://start-developer-competition-26.devpost.com (deadline Nov 18 2026, 12:00 PM PT).
Entertainment track, New Experience division, team: Ojasva (representative), Vishal, Ian.

Rule 4: the project may not mention or depict any identifiable person other than the entrants, so everything below
shows or names only Ojasva, Vishal and Ian. The judged build is `https://getluciddreams.vercel.app/xr/?event=meta`.

## Project name

Lucid Dreams

## Elevator pitch (140 characters)

Any photo or video of a person becomes them, photoreal and life-size in your room. Talk with them, learn their moves, play them at chess.

## About the project

## Inspiration

Ian hasn't been home in four years. The people he misses live in his camera roll, six inches tall, and you can't sit across a table from a video. Everyone has those videos: a friend's jump shot, a teacher's guitar lesson, someone you love telling a story. We wanted any of them to step out of the phone and stand in the room with you, at their real height, close enough to walk around.

## What it does

You give Lucid Dreams a short video of a person, or a few photos, plus one sentence about what you want to do with them: "teach me this strum", "play chess with me", "just hang out". It rebuilds the person as hundreds of thousands of tiny 3D Gaussians and puts them in your Quest's passthrough, standing on your real floor at real scale.

There are two kinds of people. A replay is the clip itself rebuilt in 3D, frame by frame: you can walk around them, freeze them mid-air and see them from angles the camera never had. An avatar is a rigged body built from photos or a few frames, so it can do things the footage never showed: sit at your table, look you in the eye, shake your hand.

Your first five minutes. Open the link on a Quest 3 or 3S and step into your room. One card shows the only gesture you need: turn your left palm up, press with your right index finger. Vishal fades in a couple of meters away, standing on your floor at his real height, breathing, and his head turns to follow you when you lean. Lean in, look at his face, walk around him. Press Talk and ask him anything; he answers in his own voice. Then sit at your table: the board lands on it, he takes the chair across from you, holds out his hand, and the game begins with a handshake.

What happens next depends on your sentence.

- Learn. Lesson mode splits the move into steps, slows each one down, repeats it, then waits for your turn. Follow along puts glowing targets where your head and hands should be right now, taken from the clip's own 22 body joints and scaled to your height. Your attempt replays as a ghost beside them, with the biggest gap called out in plain words ("left hand 18 cm low at the drop"), and a card gives every step its stars.
- Talk. A person who agreed to it answers out loud in their own cloned voice, captioned and labelled AI voice, a median 3.1 s after you stop speaking.
- Play. Chess lands on your real table with them in the chair across from you. They hold out a hand before the first move, think, reach over, move their own pieces and hit the clock, and they remember how your last game went.
- Reality check. One tap turns everything the camera never saw blue and tells you how much of the person was real.

Why you'd come back: the people you add stay in your library, the board and the chair stay where you put them in your room, an unfinished game is still on the table tomorrow, he plays one level stronger every time you beat him, and he remembers how the last game went because that memory is a real record of it.

The build you'll judge follows the competition's rule that only entrants appear, so the person waiting in it is our teammate Vishal, rebuilt from a short phone video of him turning around. Vishal and Ian are on this team, and Vishal agreed to his likeness and his cloned voice. 75% of him was really seen by the camera.

## How we built it

### Any video in: the replay pipeline

A camera only ever sees one side of a person, so rebuilding a moving person in 3D used to take a ring of synchronized cameras. 4DAnyone (August 2026) gets there from one casual clip: it generates 48 consistent views of the person in three rings of 16 cameras, 121 frames at 25 fps. On the University of Florida's HiPerGator, 12 NVIDIA B200s fit about 290,000 3D Gaussians per frame with gsplat, 7,000 Adam steps for the first frame and 1,500 for each later one, warm-started from the one before. Each frame minimizes

$$\mathcal{L} = 0.8\,\lVert \hat I - I \rVert_1 + 0.2\,\big(1-\mathrm{SSIM}(\hat I, I)\big) + 0.1\,\lVert \hat A - A \rVert_1 + 0.3\,\mathcal{L}_{\text{VGG}} + \mathcal{L}_{\text{reg}}$$

where $\hat I$ and $I$ are our render and the target view, $\hat A$ and $A$ the rendered and true silhouettes, $\mathcal{L}_{\text{VGG}}$ a perceptual loss, and $\mathcal{L}_{\text{reg}}$ small penalties on opacity, scale and stretched Gaussians. Every frame ships as SPZ (about a tenth of a PLY), with GVHMR's 22 body joints for the lessons. A Gaussian counts as seen when a camera facing the real clip finds it in front of everything else, $z_i \le D(u_i) + 4\,\text{cm}$ with accumulated opacity above 0.5; the rest is what Reality check paints blue. Against the generated views our replays reach 26.0 to 31.9 dB PSNR and 0.963 to 0.982 SSIM. Reconstruction runs at about a minute per frame per GPU once warm, so a 121-frame clip split across 12 GPUs takes roughly a quarter of an hour after the views are generated.

### A few photos in: the avatar pipeline

LHM++ (photos in, a rigged 3D body out) built Vishal's 190,815-Gaussian body on the SMPL-X skeleton from 14 frames of his video. UIKA, which rebuilds a head from a set of photos, made his face; we rendered that head from 91 viewpoints and fit fresh, opaque Gaussians to the renders directly on the body's own head, so nothing is pasted on. On held-out views the distilled head scores 29.0 dB PSNR against UIKA, up from 18.7 dB for the head LHM++ guessed. Blinks are fitted to his own eyelids through FLAME; a 20-second idle adds 2-3 mm of breathing at 0.25 Hz and small glances; eye contact turns his head 70% and neck 30%, up to 35 degrees to either side and 20 up or down, settling in about 300 ms. The browser poses every Gaussian each frame with dual-quaternion skinning.

### Your room

The app is WebXR in the Quest browser, three.js with the Spark splat renderer, hands only, from one link with no install. People stand on your real floor through a local-floor reference space. WebXR plane detection reads the planes from the Quest's Space Setup: the chessboard goes on the plane labelled table (or any horizontal plane 55 to 95 cm high) with the chair on its far side, and with no table in five seconds we bring our own and say so. WebXR anchors pin people and the board through recenters and drift, and a persistent anchor brings the board back to the same spot next session.

### Speed

Splats cost screen area, not triangles. Per eye, per frame,

$$N_{\text{px}} = \sum_i 4k^2\,\sigma_{1i}\,\sigma_{2i}\left(\frac{f}{z_i}\right)^2$$

for Gaussian $i$ with on-screen standard deviations $\sigma_{1i}, \sigma_{2i}$ in meters, drawn out to $k$ standard deviations, at depth $z_i$, with focal length $f$ in pixels. A full replay at 1.8 m is 116 million shaded pixels per eye. The headset keeps the 160,000 Gaussians that add most to the image (82 million), the session asks the Quest for 72 Hz, and a governor watches frame times the way a game's dynamic resolution does: below 85% of the display rate it steps down through five levels of splat extent ($k$ from 2.83 to 1.9), faint-Gaussian culling and foveation, and above 95% it steps back up. With Vishal at the board it holds 72 fps, and he loads as 18 MB.

### Voice, hands and sound

Talk: Whisper transcribes you, gpt-4o-mini writes a short reply from notes the person wrote about themselves (at the chess table, plus the position, the last moves, the evaluation and your last game), and ElevenLabs Flash speaks it in their cloned voice, 1.5 s to hear, 1.0 s to write and 0.5 s to speak. It can't invent memories and never runs past 320 characters. Take the services away and the person still moves, blinks, looks at you and plays.

Hands: no controller anywhere. The menu appears on your left palm and you press it with your right index finger. At the board, a blue ring shows which piece your pinch will take; captures go into your hand until you hit the clock. Every reach and handshake is arm IK on the avatar's own skeleton, and a checker replays about 75,000 frames of reaches to all 64 squares, clock presses and whole games: no finger goes more than 5 mm into the board, a piece, the clock or the body.

Sound: no audio files at the table. Each piece set down gets a synthesized wooden clack in one of three pitches, the clock a soft click, and every sound plays from where it happened. Voices come from the speaker's mouth.

## Challenges we ran into

Phantom limbs. 4DAnyone's generated person and the real one in the clip sit a few centimeters apart, and training on both gave people a second pair of shoes. Now each frame aligns the real camera to the generated person and counts real pixels only where the two agree: spill outside the person fell from 2.3% to 0.4% and view PSNR rose 0.5 to 2.1 dB.

Overdraw. The first full replay drew at 4 fps on a Quest 3S, because every Gaussian is a quad and a person a meter away covers the screen a hundred layers deep. The budget, the 72 Hz target and the governor are the fix.

Hands only, for real. In our first headset session the board moved whenever someone held a pinch in mid-air. We moved every control to the palm menu, anchored everything, and made sure no gesture does anything on its own.

## Accomplishments that we're proud of

Any phone video becomes a person you can walk around, learn from, talk to and play, at their real height in your own room, from one link with no install.

## What we learned

Realism comes from data that agrees more than from a better optimizer. Speed in a headset is about pixels covered, not polygons. And showing people what was generated makes them trust what was real.

## What's next

Faster turnaround from upload to your room, sharper faces up close, more than one person at a time, and a Meta Horizon Store release in spring 2027.

## Built with

webxr, three.js, spark, gaussian-splatting, gsplat, 4danyone, lhm++, uika, flame, smpl-x, gvhmr, pytorch, python, typescript, vite, meta-quest, hand-tracking, passthrough, plane-detection, webxr-anchors, stockfish, whisper, openai, elevenlabs, hipergator

## Try it out

- In a Quest 3 or 3S browser: https://getluciddreams.vercel.app/xr/?event=meta

## Additional info

- Submitter type: Team of Individuals
- Country of residence: United States
- Meta VR Start email: ojasvamishra32@gmail.com (check this is the address on the Start membership)
- Team: Ojasva Mishra, ojasvamishra32@gmail.com, representative: reconstruction pipeline and GPU runs, the WebXR headset app, chess, rendering performance. Vishal Naveen, vishalnaveen.03@gmail.com: avatars (LHM++ bodies, UIKA faces, blinks, cloned voice), the website. Ian Hoang, [email needed]: native Quest app, hand interactions, eye contact, the Talk server.
- Team or organization name: Lucid Dreams
- Track: Entertainment (interactive video of real people; the judges picked Gaming only for the chess-first draft)
- Division: New (conceived and built from Oct 23, 2026)
- Build path: Other (WebXR: three.js and Spark, not IWSDK)
- Release link: https://getluciddreams.vercel.app/xr/?event=meta

### What Meta VR capabilities did you use?

- Passthrough: an immersive-ar session on a local-floor reference space, so Vishal and the board sit at real scale on your real floor and table.
- Scene understanding: WebXR plane detection reads the planes from the Quest's Space Setup. The board goes on the plane labelled table, or any horizontal plane 55 to 95 cm high, and Vishal's chair goes on its far side. With no table found in five seconds, the app brings its own and says so.
- Spatial anchors: WebXR anchors pin the board and his chair through recenters and drift; a persistent anchor brings them back to the same place next session.
- Hand tracking: WebXR Hand Input, all 25 joints of both hands, drives the palm menu, piece grabs, captures, the clock and the handshake. No controller is ever needed.
- Head pose: he keeps eye contact (head 70%, neck 30%, up to 35 degrees left or right and 20 up or down, settling in about 300 ms).
- FoV-aware layout: the menu opens 6 cm above your palm, captions sit beside his face and the status panel stands at the edge of the board, so everything you need is in front of you and nothing depends on the edges of a narrower field of view.
- Performance controls: the session asks for 72 Hz (updateTargetFrameRate), and framebuffer scale and fixed foveation are stepped live by our frame-time governor to hold it.
- Spatial audio: his voice comes from his mouth, and every synthesized piece clack, clock click and handshake tap plays from where it happened.

### How are hand interactions implemented?

There are no controllers anywhere, from the first screen to the last move. The first time you enter, a short card shows the one gesture you need: turn your left palm up for the menu, press with your right index finger. The menu lives on your left palm like the Quest's own: the buttons appear 6 cm above your open hand and only a right index fingertip presses them. Nothing floats where a busy hand could brush it, and no pinch or gesture does anything by itself.

Pieces are taken with a pinch. Before your fingers close, a blue ring shows the piece the pinch would take and the landing square lights; a pinch only takes hold as it starts, and it rides out tracking jitter and one-frame finger flicker, so a piece doesn't drop by accident. A capture goes into your hand: hit the clock with that hand, then set the piece down beside the board. You can also lift his piece with one hand and take with the other.

Before the game Vishal holds his hand out across the table. Hold yours out, palm sideways with your fingers straight (a fist, a pinch or a piece in your hand never counts), and within 12 cm he takes it, follows your hand through two or three shakes by arm IK and lets go with a nod. Talk is press, speak, press. The board moves only by the handle on your side, then locks to the room again.

### What makes you excited about the future of VR? (150 words)

Most of our lives with the people we love are on video now, and none of it lets you be in the room with them. Headsets are the first device where a person can be the right height, in your space, looking back at you. Until recently, a moving person you could walk around took a ring of synchronized cameras to capture. Now one phone clip is enough, and the browser on a Quest can draw them. We think the next few years of VR are less about new worlds and more about bringing the people from ours into the room: a friend across your table, a teacher beside you, family you haven't seen in years. That's the part that makes us want to keep building.

### Target launch date

Spring 2027, Meta Horizon Store (the WebXR build is live now).

## Video: what has to change (under 3:00, public on YouTube, only Ojasva, Vishal and Ian on screen)

The Gator Hack film (`~/Downloads/luciddreamssubmission.mov`, 3:00.0) can't go in as it is. Rule 4 bars any identifiable
person who isn't an entrant (Fischer, Carlsen, Federer, LeBron, Ian's grandma, the Pexels performers), the NBA play
fails the no-brands rule, and 3:00.0 isn't "less than three minutes". Keep its style (real headset footage, SF Pro,
x-ray inserts, one song) and its best entrant shots, and film the rest in the headset with the `?event=meta` build:

| Time | Shot | Source |
| --- | --- | --- |
| 0:00-0:15 | Ian on his bed scrolling his camera roll at night, "I haven't been home in four years" (his words) | film, Ian's b-roll (entrant) |
| 0:15-0:20 | Black, "Lucid Dreams" | film |
| 0:20-0:40 | Vishal's phone video, then the headset view: he appears in the room, life size, and looks at you | new headset take |
| 0:40-1:05 | Talk: "What's up, Vishal?", his answer in his own voice, AI voice caption, the timing bar | film (Vishal, entrant) + new take |
| 1:05-1:15 | X-ray: his 14 frames flying into 190,815 Gaussians | film insert |
| 1:15-1:55 | Chess: the board landing on a real table, his handshake, his reach, the clock | new headset take, `?event=meta&mode=chess` |
| 1:55-2:10 | Reality check on Vishal: blue where the camera never looked, "75% seen" | new take |
| 2:10-2:30 | Hands only: palm menu, pinch ring, capture into the hand, the clock hit | new take |
| 2:30-2:50 | Ojasva and Ian, headsets off, across the table from an empty chair | new |
| 2:50-2:58 | "Lucid Dreams. The people in your phone, in your room." link, team | end card |

Ojasva and Ian can join the cast as replays from their own phone clips (one person, full body, still camera, 5 s at
25 fps or more, bright even light), which gives the build and the video a lesson or a moment that isn't Vishal.

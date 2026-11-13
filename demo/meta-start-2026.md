# Meta VR Start Developer Competition 2026: Lucid Dreams

Draft answers for https://start-developer-competition-26.devpost.com (deadline Nov 18 2026, 12:00 PM PT).
Entertainment track, New Experience division, team: Ojasva (representative), Vishal, Ian.

Ojasva's call (Nov 13): the judged build and the film show everyone we built, each public figure labelled "not
affiliated", knowing Rule 4 ("Projects may not mention or depict any identifiable person other than Entrants") lets
Meta disqualify for it. The judged build is `https://getluciddreams.vercel.app/xr/?event=meta`: it opens on Vishal,
and the library, chess with the legends, tennis, Court Side and every replay are one tap away.

## Project name

Lucid Dreams

## Elevator pitch (140 characters)

Anyone from any video, standing in your room.

## About the project

Lucid Dreams brings someone from your phone's videos into your room. One short clip or a few photos becomes the person, photoreal and standing life size in passthrough on a Meta Quest.

Ian hasn't been home to Vietnam in four years, and his grandmother lived in his camera roll, six inches tall. One video of her became her, at her real height on his floor. When he talks to her in Vietnamese she answers in her own voice, cloned with her and her family's consent and labelled as AI.

It works the same for anyone you have a video of. Walk all the way around them, talk with them, learn a move from them or sit across your own table from them, with your hands only, from one link in the Quest browser. When you open the build, our teammate Vishal's phone video plays life size in front of you, and then he steps out of it and looks at you.

## Inspiration

Most of the people we love live in our phones now: a parent laughing at dinner, a friend's jump shot, a teacher showing a guitar strum, a grandparent telling the story they always tell. You can't sit across a table from a video. We wanted the people in those videos to step out of the phone and stand in the room with you, at their real height, close enough to walk around.

Ian's grandmother was the first. Then we kept going: a guitar teacher who sits beside you, Bobby Fischer and Magnus Carlsen across a chessboard on your own table, Roger Federer on the far baseline.

## What it does

It's interactive video. Open a video and the person in it steps out: the clip plays life size in your room, wipes away from the feet up, and they're standing there at their real height, looking at you. Give Lucid Dreams a short video or a few photos plus one sentence ("teach me this strum", "play chess with me", "just hang out"), and it rebuilds that person from hundreds of thousands of tiny 3D Gaussians, standing on your real floor in your Quest's passthrough. Reality check paints blue whatever the camera never saw.

There are two kinds of people. A replay is the clip itself rebuilt in 3D, frame by frame: you can walk around them, freeze them mid-air and see them from angles the camera never had. Open the dance routine and its 5-second source clip plays life size first; then the dancer steps out of it and dances the same routine in 3D, where you can watch it from every side. An avatar is a rigged body built from photos or a few frames, so it can do things the footage never showed: sit at your table, look you in the eye, shake your hand.

Your first five minutes. Open the link on a Quest 3 or 3S and step into your room. Vishal's phone video plays a couple of meters away, life size: seven seconds of him turning around in a hallway, the clip he was made from. As he turns to face you, the video wipes away from his feet up and he's standing there instead, on your floor at his real height, breathing. He says hi first, one line of his own about how a minute ago he was a video on a phone. Then one card shows the only gesture you need: turn your left palm up, press with your right index finger. From your chair, lean in and look at his face; his head turns to follow you. (You can stand and walk around him. You never have to.) Press Talk and ask him anything; he answers in his own voice. Then sit at your table: the board lands on it, he takes the chair across from you, holds out his hand, and the game begins with a handshake.

What happens next depends on your sentence.

- Learn. The guitar teacher sits beside you and scores every strum against the clip's own beat ("Early 102 ms", "On beat", a streak); the golfer tees up a ball at your feet and your swing sends it flying (Library, Guitar and Golf). Lesson mode splits the move into steps, slows each one down, repeats it, then waits for your turn. Follow along puts glowing targets where your head and hands should be right now, taken from the clip's own 22 body joints and scaled to your height. Your attempt replays as a ghost beside them, with the biggest gap called out in plain words ("left hand 18 cm low at the drop"), and a card gives every step its stars.
- Talk. A person who agreed to it answers out loud in their own cloned voice, captioned and labelled AI voice, a median 3.1 s after you stop speaking.
- Play. Chess lands on your real table with them in the chair across from you. They hold out a hand before the first move, think, reach over, move their own pieces and hit the clock, and they remember how your last game went. Pick Fischer's or Carlsen's level and their avatar sits down (labelled "Stockfish at Fischer's peak rating. Not affiliated."), or sit down at a position from one of their real games and find the move they're remembered for. Tennis puts Roger Federer's avatar on the far baseline of a full-size grass court: serves, faults, lets, deuce, tiebreaks, and a ball that dips with topspin and skids on the grass. In your room, LeBron plays his own jump shot until your pass reaches him, then catches it and shoots.
- Court Side. A real NBA moment, Luka Dončić's step-back three over Rudy Gobert, plays as courtside video around you. Step into the court and that one frame becomes 3D: every player frozen mid-air at real size, and you walk between them before the ball leaves his hand.
- Reality check. One tap turns everything the camera never saw blue and tells you how much of the person was real.

Why you'd come back: next time Vishal is waiting where you left him in your room (a persistent anchor) and greets you like he remembers, because Talk is told how many times you've visited and when; the people you add stay in your library, the board and the chair stay where you put them in your room, an unfinished game is still on the table tomorrow, he plays one level stronger every time you beat him, and he remembers how the last game went because that memory is a real record of it.

The build you'll judge opens on our teammate Vishal, rebuilt from a short phone video of him turning around; he agreed to his likeness and his cloned voice, and 75% of his Gaussians were seen in his own frames (Reality check paints the rest blue). Everyone else is one press away, under Library on the palm menu: Ian's grandmother, six replays you can learn from (guitar, golf, tai chi, a dance routine, two jump shots), the chess legends, Federer and Court Side. Every public figure is labelled not affiliated, and none of them ever speaks. In the judged build you can't upload your own clip yet: Make a dream runs on our university's GPU cluster, and everyone in the library came from that pipeline. Tennis and Court Side are played standing (Court Side switches to full immersion); everything else works from a chair.

## How we built it

### Any video in: the replay pipeline

A camera only ever sees one side of a person, so rebuilding a moving person in 3D used to take a ring of synchronized cameras. 4DAnyone (August 2026) gets there from one casual clip: it generates 48 consistent views of the person in three rings of 16 cameras, 121 frames at 25 fps. On the University of Florida's HiPerGator, 12 NVIDIA B200s fit about 290,000 3D Gaussians per frame with gsplat, 7,000 Adam steps for the first frame and 1,500 for each later one, warm-started from the one before. Each frame minimizes

$$\mathcal{L} = 0.8\,\lVert \hat I - I \rVert_1 + 0.2\,\big(1-\mathrm{SSIM}(\hat I, I)\big) + 0.1\,\lVert \hat A - A \rVert_1 + 0.3\,\mathcal{L}_{\text{VGG}} + \mathcal{L}_{\text{reg}}$$

where $\hat I$ and $I$ are our render and the target view, $\hat A$ and $A$ the rendered and true silhouettes, $\mathcal{L}_{\text{VGG}}$ a perceptual loss, and $\mathcal{L}_{\text{reg}}$ small penalties on opacity, scale and stretched Gaussians. Every frame ships as SPZ (about a tenth of a PLY), with GVHMR's 22 body joints for the lessons. A Gaussian counts as seen when a camera facing the real clip finds it in front of everything else, $z_i \le D(u_i) + 4\,\text{cm}$ with accumulated opacity above 0.5; the rest is what Reality check paints blue. Against 4DAnyone's views the fit trained on (every 8th of the 48 cameras, median over 121 frames; none held out, so read it as how well the fit converged, not accuracy from unseen angles), our replays reach 26.0 to 31.9 dB PSNR and 0.963 to 0.982 SSIM. Reconstruction runs at about a minute per frame per GPU once warm, so a 121-frame clip split across 12 GPUs takes roughly a quarter of an hour after the views are generated.

### A few photos in: the avatar pipeline

LHM++ (photos in, a rigged 3D body out) built Vishal's 190,815-Gaussian body on the SMPL-X skeleton from 14 frames of his video. UIKA, which rebuilds a head from a set of photos, made his face; we rendered that head from 91 viewpoints and fit fresh, opaque Gaussians to the renders directly on the body's own head, so nothing is pasted on. On viewpoints held out of the fit, the distilled head matches UIKA's own renders at 29.0 dB PSNR, up from 18.7 dB for the head LHM++ guessed (a measure of how faithfully the head was carried over, not a likeness score). Blinks are fitted to his own eyelids through FLAME; a 20-second idle adds 2-3 mm of breathing at 0.25 Hz and small glances; eye contact turns his head 70% and neck 30%, up to 35 degrees to either side and 20 up or down, settling in about 300 ms. The browser poses every Gaussian each frame with dual-quaternion skinning.

### Your room

The app is WebXR in the Quest browser, three.js with the Spark splat renderer, hands only, from one link with no install. People stand on your real floor through a local-floor reference space. WebXR plane detection reads the planes from the Quest's Space Setup: the chessboard goes on the plane labelled table (or any horizontal plane 60 to 95 cm above the floor; a lower coffee table gets our own table instead) with the chair on its far side, and with no table in five seconds we bring our own and say so. WebXR anchors pin people and the board through recenters and drift, and a persistent anchor brings the board back to the same spot next session. Your tracked hands and the detected table are drawn depth-only, so your fingers pass in front of him and his legs stay hidden under your real table; the session also asks for WebXR depth sensing, so where the headset provides it, real furniture can hide people too. A replay streams its 121 frames as SPZ, about 4 MB each, and starts playing once a quarter of them are in; Vishal is 18 MB. If you've been turned away from him or the board for 2 s, a small chevron near the middle of your view points the way back.

### Games

Chess runs Stockfish 19 (single-threaded WASM) in a web worker at seven levels: 1400, 2000, 2400, 2700, Fischer's peak rating (2785), Carlsen's (2882) and full strength. The ratings are Stockfish's own UCI_Elo scale, calibrated at desktop speed, so they're a level, not a claim about the man. Tennis is our own physics at a fixed 240 Hz step, shared by live play, the opponent's predictions and the shot solver, so what the AI predicts is what happens. The 57 g, 6.7 cm ball follows

$$\dot{\mathbf v} = \mathbf g - k_D\,\lvert\mathbf v\rvert\,\mathbf v + k_L\,C_L\,\lvert\mathbf v\rvert^2\,\frac{\boldsymbol\omega\times\mathbf v}{\lvert\boldsymbol\omega\rvert\,\lvert\mathbf v\rvert},\qquad k_D=\frac{\rho\,C_D A}{2m},\quad k_L=\frac{\rho A}{2m},\quad C_L=\min\!\left(0.32,\ \frac{1}{2+\lvert\mathbf v\rvert/(r\lvert\boldsymbol\omega\rvert)}\right)$$

with $C_D = 0.55$ and $\rho = 1.21\,\text{kg/m}^3$, so topspin dips and slice floats. Spin decays by a seventh each second in the air, and the grass bounce trades pace for spin through friction at the contact patch ($\mu = 0.42$, low and skiddy). Federer's avatar moves with real tennis motion we captured from clips with GVHMR (ready, split step, shuffles, sprints, forehand, backhand, three serves), foot-locked so his shoes don't slide.

### Speed

Splats cost screen area, not triangles. Per eye, per frame,

$$N_{\text{px}} = \sum_i 4k^2\,\sigma_{1i}\,\sigma_{2i}\left(\frac{f}{z_i}\right)^2$$

for Gaussian $i$ with on-screen standard deviations $\sigma_{1i}, \sigma_{2i}$ in meters, drawn out to $k$ standard deviations, at depth $z_i$, with focal length $f$ in pixels. A full replay at 1.8 m is 116 million shaded pixels per eye. The headset keeps the 160,000 Gaussians that add most to the image (82 million), the session asks the Quest for 72 Hz, and a governor watches frame times the way a game's dynamic resolution does. After 0.4 s below 85% of the display rate it steps down through five levels of splat extent ($k$ from 2.83 to 1.9), faint-Gaussian culling and foveation; after 5 s above 95% it tries one level sharper. A try that doesn't hold is undone within a second and doubles the wait before the next one, up to a minute, so a scene that only just fits never stutters every few seconds probing. Simulated on a scene whose sharpest level draws at 55 fps (`scripts/check_governor.ts`), it tries again at 7, 18, 38, 79 and 140 s, and 1.9% of frames run late over three minutes. On our Quest 3S at its default 90 Hz, the `?fps=1` readout shows a steady 75 fps in every scene (the opening, Vishal at the chess board, the replays, tennis and Court Side), about 13.3 ms a frame, with the governor free to trade splat extent for time. The judged link asks for 72 Hz, a 13.9 ms budget, which every scene fits. Vishal loads as 18 MB. Add `?fps=1` to the link to see the frame rate, the p95 frame time and the governor's level live in the headset.

### Voice, hands and sound

Talk: Whisper transcribes you, gpt-4o-mini writes a short reply from notes the person wrote about themselves (at the chess table, plus the position, the last moves, the evaluation and your last game), and ElevenLabs Flash speaks it in their cloned voice, 1.5 s to hear, 1.0 s to write and 0.5 s to speak. Its instructions forbid inventing memories, and replies are capped at 320 characters. If the voice service is ever down, the reply still arrives as captions beside them, never in a stand-in voice. Take the services away and the person still moves, blinks, looks at you and plays.

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

Faster turnaround from upload to your room, sharper faces up close, more than one person at a time, and a Meta Horizon Store release in spring 2027. Before that release we'll swap the research-only parts (SMPL-X, GVHMR and LHM++'s weights are licensed for non-commercial use) for commercially licensed ones.

## Built with

webxr, three.js, sparkjs, gaussian-splatting, gsplat, 4danyone, lhm++, uika, flame, smpl-x, gvhmr, pytorch, python, typescript, vite, meta-quest, hand-tracking, passthrough, plane-detection, webxr-anchors, stockfish, whisper, openai, elevenlabs, hipergator

## Try it out

- In a Quest 3 or 3S browser: https://getluciddreams.vercel.app/xr/?event=meta

## Additional info

- Submitter type: Team of Individuals
- Country of residence: United States
- Meta VR Start email: ojasvamishra32@gmail.com (check this is the address on the Start membership)
- Team: Ojasva Mishra, ojasvamishra32@gmail.com, representative: reconstruction pipeline and GPU runs, the WebXR headset app, chess, rendering performance. Vishal Naveen, vishalnaveen.03@gmail.com: avatars (LHM++ bodies, UIKA faces, blinks, cloned voice), the website. Ian Hoang, ianhoang.dev@email.com: native Quest app, hand interactions, eye contact, the Talk server.
- Team or organization name: Lucid Dreams
- Track: Entertainment
- Division: New (conceived and built from Oct 23, 2026)
- Build path: Other (WebXR: three.js and Spark, not IWSDK)
- Release link: https://getluciddreams.vercel.app/xr/?event=meta

### What Meta VR capabilities did you use?

- Passthrough: an immersive-ar session on a local-floor reference space, so Vishal and the board sit at real scale on your real floor and table. His own phone video plays life size in your room first, and he steps out of it onto your floor.
- Scene understanding: WebXR plane detection reads the planes from the Quest's Space Setup. The board goes on the plane labelled table, or any horizontal plane 60 to 95 cm above the floor, and Vishal's chair goes on its far side. With no table found in five seconds, the app brings its own and says so.
- Spatial anchors: WebXR anchors pin the board and his chair through recenters and drift; a persistent anchor brings them back to the same place next session.
- Hand tracking: WebXR Hand Input, all 25 joints of both hands, drives the palm menu, piece grabs, captures, the clock and the handshake. No controller is ever needed.
- Head pose: he keeps eye contact (head 70%, neck 30%, up to 35 degrees left or right and 20 up or down, settling in about 300 ms).
- FoV-aware layout: the menu opens 6 cm above your palm, captions sit beside his face and the status panel stands at the edge of the board, so everything you need is in front of you and nothing depends on the edges of a narrower field of view.
- Performance controls: the session asks for 72 Hz (updateTargetFrameRate), the framebuffer scale is set per scene when the session starts (0.8, or 0.7 for replays), and fixed foveation, splat extent and faint-Gaussian culling are stepped live by our frame-time governor to hold the rate.
- Occlusion: your tracked hands and the detected table are drawn depth-only, so your fingers cover him and his legs stay under your real table; the session also asks for WebXR depth sensing, so where the headset provides it, real furniture hides people too.
- Spatial audio: his voice comes from his mouth, and every synthesized piece clack, clock click and handshake tap plays from where it happened.

### How are hand interactions implemented?

There are no controllers anywhere, from the first screen to the last move. The first time you enter, a short card shows the one gesture you need: turn your left palm up for the menu, press with your right index finger. The menu lives on your left palm like the Quest's own: the buttons appear 6 cm above your open hand and only a right index fingertip presses them. Nothing floats where a busy hand could brush it, and no pinch or gesture does anything by itself.

Pieces are taken with a pinch. Before your fingers close, a blue ring shows the piece the pinch would take and the landing square lights; a pinch only takes hold as it starts, and it rides out tracking jitter and one-frame finger flicker, so a piece doesn't drop by accident. A capture goes into your hand: hit the clock with that hand, then set the piece down beside the board. You can also lift his piece with one hand and take with the other.

Before the game Vishal holds his hand out across the table. Hold yours out, palm sideways with your fingers straight (a fist, a pinch or a piece in your hand never counts), and within 12 cm he takes it, follows your hand through two or three shakes by arm IK and lets go with a nod. Talk is press and speak: when you pause it sends itself (or press again). The first turn says that your words go to OpenAI and ElevenLabs to answer, and getluciddreams.vercel.app/privacy says what's kept (no recordings). The board moves only by the handle on your side, then locks to the room again.

### What makes you excited about the future of VR? (150 words)

Most of our lives with the people we love are on video now, and none of it lets you be in the room with them. Headsets are the first device where a person can be the right height, in your space, looking back at you. Until recently, a moving person you could walk around took a ring of synchronized cameras to capture. Now one phone clip is enough, and the browser on a Quest can draw them. We think the next few years of VR are less about new worlds and more about bringing the people from ours into the room: a friend across your table, a teacher beside you, family you haven't seen in years. That's the part that makes us want to keep building.

### Target launch date

Spring 2027, Meta Horizon Store (the WebXR build is live now).

## Video

https://youtu.be/oM1dQDXVtBE ("Lucid Dreams - Meta Dev 2026", public, 3:00.05, thumbnail: a phone's video streaming into
a life-size person made of points). The Gator Hack film as it is, by Ojasva's call: Ian and his grandmother, how a
person is made (the Quest 3S, 48 views, the fit, the Gaussians, Reality check), the guitar and golf lessons, chess
against Fischer and Carlsen, tennis against Federer, LeBron's pass, Court Side, Vishal's Talk, the frame budget, the
headsets coming off, everyone side by side. Known risks: Rule 4 (people who aren't entrants), the soundtrack is a
commercial song (a Content ID claim, no effect on viewing), and 3:00.05 is 0.05 s past "less than three (3) minutes"
(judges needn't watch past 3:00; it falls on the end card). Nov 13: a fixed blur in YouTube Studio covers the end card's
grey lines (the names with Atina, "Gator Hack V · University of Florida", the disclaimer) from 2:53:00 to the end, same
link; the title, the line under it and getluciddreams.vercel.app stay sharp.

### Entrants-only cut (not used)

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

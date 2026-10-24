# Quest app

Photoreal Gaussian people standing on your real floor in Meta Quest 3S passthrough.

- Unity **6000.6.0f1** (the VR Gaussian renderer needs Unity 6000.3 or later) with **Android Build Support**
  (OpenJDK + Android SDK & NDK) added in Unity Hub.
- URP, OpenXR + Meta OpenXR (passthrough, floor planes), AR Foundation, Input System.
- Renderer: [ninjamode/Unity-VR-Gaussian-Splatting](https://github.com/ninjamode/Unity-VR-Gaussian-Splatting) (MIT),
  pinned by commit in `Packages/manifest.json`.

## Set up

1. Open `apps/quest` in Unity 6000.6.0f1.
2. **Lucid Dreams > Set Up Project** (safe to run again). It configures URP with the Gaussian pass, OpenXR for
   Android and desktop, the Android player settings and `Assets/LucidDreams/Scenes/Dream.unity`.
3. Tell the headset where the bridge is (Raami's web app on the Mac, port 5170), then **Build And Run** on the Quest,
   or **Lucid Dreams > Build APK**:

   ```
   adb shell "echo http://<mac-ip>:5170 > /sdcard/Android/data/com.luciddreams.quest/files/bridge.txt"
   ```

   (or set **Library > Dream Library > Bridge Url** in the scene before building).

## Library

The library lists the bridge's dreams (`GET /api/dreams`) and the ones already on the headset. **Get** downloads a
bundle's SPZ frames, reality frames, `experience.json`, thumb and any guide or audio into the app's storage (never
the multi-GB PLYs), with progress; it lands in `<id>.part` and is renamed only when complete. **Play** plays it from
the headset, so downloaded dreams work with no bridge (the panel says when it's offline). At launch the app replays
the last dream you played if it's there, otherwise the library opens by itself. Avatars show as "Soon" until the
avatar player lands.

## Playing a replay

`DreamSequencePlayer` loads every frame of a bundle before it plays, keeps them all on the GPU in full float
precision, and switches frames at the clip's fps through the renderer's deformation hook, so playback never uploads
or stutters. **Format** picks the frames: `Auto` (default) uses the full-quality PLY frames (SH degree 1) when the
bundle has all of them, otherwise the SPZ frames (about 10x smaller, colour only, what the bridge serves by default).
**Bundle** can be:

- a folder under the app's storage: `dreams/<id>` means `/sdcard/Android/data/com.luciddreams.quest/files/dreams/<id>`
  on the Quest (copy one there with `adb push <bundle> /sdcard/Android/data/com.luciddreams.quest/files/dreams/`),
- a folder under `Assets/StreamingAssets/` (git-ignored, ships inside the APK),
- the bridge: `http://<mac>:5170/dreams/<id>`, or an absolute folder in the editor.

GPU cost is 72 bytes per Gaussian per frame for PLY (SH degree 1) and 56 for SPZ: 121 frames x 300k Gaussians is
about 2.5 GB or 1.9 GB.
The player refuses bundles over `gpuBudgetMB` and logs the Gaussian count that would fit.

## Avatars

Avatar bundles (`kind: "avatar"` with `avatar.skin`, `avatar.skeleton`, `avatar.motion`) play live, posed on the
GPU like `apps/webxr/src/avatar.ts`: the rest-pose Gaussians (`avatar.ply`, full float precision) are skinned every
display frame by `Shaders/AvatarSkinning.compute` (4 bones per Gaussian, dual-quaternion blend, each Gaussian's
own rotation turned too). The per-bone transforms are avatars/README.md's "Posing one frame", in the bundle's own
space, with each joint slerped between motion frames, so 30 fps motion is smooth at 72 Hz. Everything else (lessons,
reality check via `avatar.reality`, speed, scrub, hands) works the same as for a replay. `expr` (blinks) is ignored,
as the README allows.

## Their voice and words

- **Voice** (`voice.m4a`, else `audio.m4a`): a 3D sound at mouth height (`bounds.max.y - 0.13`), 8 cm in front of the
  face, full within 1.2 m and falling off beyond, kept within 0.12 s of the clip. Quiet while paused, during your
  turn in a lesson, and below 1x (no pitch-correct time stretch yet). On the Quest the AAC is decoded with Android's
  MediaExtractor + MediaCodec (Unity can't open AAC at runtime); the macOS editor converts it with `afconvert`.
  Unity's own spatializer pans it (no HRTF: that needs Meta's audio SDK).
- **Captions** (`captions.vtt`): a quiet dark pill in front of them at 60% of their height, toward you, fading in and
  out with each cue, up to two lines.

## Props (props.json)

The ball and hoop are built in code at real size, like `apps/webxr/src/props.ts`, as children of the person (so they
share its space and come along wherever it's placed):

- **Basketball:** follows `track` on the same clip clock as the person (lessons included): centripetal Catmull-Rom
  between frames, straight lines in and out of a floor bounce, never through the floor, fades out across `null`s and
  in after a jump, backspin from its velocity, a soft shadow that widens with height. The pebbled skin and its
  8 seams are generated (worker thread) with a matching normal map.
- **Hoop:** regulation: ring 0.457 m inside at `rim` height, board 1.83 x 1.07 m with its border and shooter's
  square, diamond net, arms, pole and base, turned to `facing`.
- Prop materials are URP Lit assets in `Assets/LucidDreams/Props/`, lit by one key light and a soft ambient that
  only solid objects see (Gaussians carry their own light). Unknown kinds are ignored.

## What you came to do (experience.json)

The player reads the bundle's `experience.json` (AGENTS.md, Contracts, "Experience"), or guesses a plan from
`dream.json`'s `intent` until one exists (same rules as the WebXR app).

- **Teach:** each step plays at its `speed`, `repeat` times, then the person freezes in the step's last pose for your
  turn (the move's length at 1x + 1.5 s, with a thin blue bar), then the next step, wrapping after the last. A step
  card floats at eye level, off to the right of the person ("Step n of N" or "Your turn", title, tip), each step is
  said aloud in the headset's own voice (Android TextToSpeech, never the person's), and the bar trades its speed
  button for **Back / Again / Next**.
- **Placement by `place`:** `facing` (1.8 m in front, facing you; default), `beside` (0.8 m to your right, 0.5 m
  ahead, facing your way), `ahead` (1.5 m ahead, facing away). A long-pinch re-place keeps that orientation.

## Hands (no controllers needed)

- **Quick pinch** anywhere: play / pause.
- **Pinch the person and drag:** they slide along the floor (never lifted, never scaled). **Both hands:** turn them.
- **Pinch and hold ~1 s pointing at the floor:** they stand there, facing you.
- **Control bar** (floats low in front of you, follows when you turn): push a fingertip through **Play/Pause**,
  **speed** (1 / 0.5 / 0.25x), **Reality check**, **Bring here** or **Library**; pinch the timeline and drag to scrub.
  Buttons fire once per push. With more than five buttons it wraps into two rows.
- **Reality check** (bundles with `frames.reality`): the first push loads the reality frames (same Gaussians, the ones
  the camera never saw tinted blue) and swaps them in at the same moment; the bar shows `metrics.seenFraction`
  ("62% seen by the camera · blue was imagined"). Push again for the real colours. It costs one more set of SPZ
  frames on the GPU (56 B per Gaussian per frame) and counts against the same budget.
- Your real hands stay in front of the person: depth-only stand-ins (`HandOccluder`) hide what's behind them.
- A soft contact shadow sits under the feet.

Controllers still work as a fallback (`DreamTestControls`): **A** play/pause, **B** speed, thumbstick scrubs,
trigger re-places; left **X** toggles the reality check. In the editor: Space, S, arrow keys, P, R.

## Checking without a headset

**Lucid Dreams > Import Dream Bundle...** puts a bundle's first frame in the scene for an edit-mode preview.

`PlaybackCheck` plays a bundle in the real scene, checks it advances at the clip's fps, and renders front and side
views of a few frames to PNG:

```
Unity -batchmode -projectPath apps/quest -executeMethod LucidDreams.Editor.PlaybackCheck.Run \
  -dreamBundle /path/to/dreams/<id> -out /tmp/lucid-check [-format auto|ply|spz]
```

`HandsCheck` drives simulated hands through every gesture in the real scene, checks each outcome and renders the
eye view (a finger in front of the person must hide it). Given a bundle with a teach plan it checks the lesson
instead: placement, step timing, your turn, Back / Again / Next and the voice; with a `voice` or `captions` it checks
those (decode, mouth position, sync, quiet when paused or slowed, cue text); with `props` it checks the ball on its
track, fades, the bounce and the hoop's regulation sizes. With `-bridge <url>` (no bundle) it
checks the library from an empty cache: list, download, play from the headset, then offline. For an avatar bundle,
`-expect <dir>` compares the GPU-skinned positions with reference poses (`frameN.bin` from `skinning.py`'s
`pose_points`, `frameN.dq.bin` from a dual-quaternion blend of its `skin_matrices`):

```
Unity -batchmode -projectPath apps/quest -executeMethod LucidDreams.Editor.HandsCheck.Run \
  -dreamBundle /path/to/dreams/<id> -out /tmp/lucid-check        # or: -bridge http://127.0.0.1:5170
```

By default the person stands 1.8 m in front of you on the scanned floor, facing you. Bundle files are right-handed
(meters, +Y up, front faces -Z); `DreamPlacer` mirrors Z into Unity's left-handed space.

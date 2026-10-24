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
3. Point the player at a bundle (`Dream/Person`, **Dream Sequence Player > Bundle**), then **Build And Run** on the
   Quest, or **Lucid Dreams > Build APK**.

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

## Hands (no controllers needed)

- **Quick pinch** anywhere: play / pause.
- **Pinch the person and drag:** they slide along the floor (never lifted, never scaled). **Both hands:** turn them.
- **Pinch and hold ~1 s pointing at the floor:** they stand there, facing you.
- **Control bar** (floats low in front of you, follows when you turn): push a fingertip through **Play/Pause**,
  **speed** (1 / 0.5 / 0.25x) or **Bring here**; pinch the timeline and drag to scrub. Buttons fire once per push.
- Your real hands stay in front of the person: depth-only stand-ins (`HandOccluder`) hide what's behind them.
- A soft contact shadow sits under the feet.

Controllers still work as a fallback (`DreamTestControls`): **A** play/pause, **B** speed, thumbstick scrubs,
trigger re-places. In the editor: Space, S, arrow keys, P.

## Checking without a headset

**Lucid Dreams > Import Dream Bundle...** puts a bundle's first frame in the scene for an edit-mode preview.

`PlaybackCheck` plays a bundle in the real scene, checks it advances at the clip's fps, and renders front and side
views of a few frames to PNG:

```
Unity -batchmode -projectPath apps/quest -executeMethod LucidDreams.Editor.PlaybackCheck.Run \
  -dreamBundle /path/to/dreams/<id> -out /tmp/lucid-check [-format auto|ply|spz]
```

`HandsCheck` drives simulated hands through every gesture in the real scene, checks each outcome and renders the
eye view (a finger in front of the person must hide it):

```
Unity -batchmode -projectPath apps/quest -executeMethod LucidDreams.Editor.HandsCheck.Run \
  -dreamBundle /path/to/dreams/<id> -out /tmp/lucid-check
```

The person stands 1.5 m in front of you on the scanned floor, facing you. Bundle files are right-handed
(meters, +Y up, front faces -Z); `DreamPlacer` mirrors Z into Unity's left-handed space.

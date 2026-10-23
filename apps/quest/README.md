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
3. **Lucid Dreams > Import Dream Bundle...** and pick a bundle folder (the one with `dream.json`). The first frame
   (or the avatar's rest pose) is imported at high fidelity into `Assets/Dreams/<id>/` (git-ignored) and put in the scene.
4. Switch to Android, plug in the Quest, **Build And Run**.

The person stands 1.5 m in front of you on the scanned floor, facing you. Bundle files are right-handed
(meters, +Y up, facing -Z); `DreamPlacer` mirrors Z into Unity's left-handed space.

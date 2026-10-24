# Lucid Dreams: the site

The public page for Lucid Dreams: one dark, scroll-driven page that shows the whole pipeline with real assets, from
the input clip to 4DAnyone's 48 generated cameras, the live 3D reconstruction, the measured fidelity and the WebXR
viewer. Vite + TypeScript, no framework; three.js 0.186.1 + Spark 2.4.0 (the same versions as `apps/webxr`).

## Run

```bash
npm --prefix apps/site install
npm --prefix apps/site run dev        # http://localhost:5190
```

The dev and preview servers pass `/api` and `/dreams` through to the bridge (`apps/web`, `http://localhost:5170`;
`LUCID_BRIDGE` points elsewhere), so the live 3D person is the real `dance-01` replay. Without a bridge (a static host,
`file://`) everything else still works from `public/media`, and the live 3D shows the committed sample person.

## Build

```bash
npm --prefix apps/site run build      # typechecks, then writes apps/site/dist
npm --prefix apps/site run preview    # serves dist on :5190, with the same bridge proxy
```

## The scenes

| Section | What it shows | Code |
| --- | --- | --- |
| Hero | `dance-01`'s render, keyed out of its black background in WebGL so she stands in front of the headline | `src/heroGl.ts` |
| One video | The input clip and its real specs | `index.html` |
| Cameras | 4DAnyone's rig drawn from its own `cameras.json`: 48 screens, each playing its tile of the camera-wall video, then flying into the 16 x 3 wall | `src/three/rig.ts` |
| Bullet time | 32 generated views on the middle ring, scrubbed by scroll (dance or tai chi) | `src/main.ts` |
| Reconstruction | Frame 0 of `dance-01`, live: the Gaussians rise as points and grow into the person; 121 frames in 12 GPU chunks | `src/three/splat.ts` |
| Measured | Real frame vs our render (drag), the PSNR table, generated views beside our renders | `index.html`, `src/main.ts` |
| Honesty | The same live person with Reality check (the bundle's own reality frame: blue = imagined), drag to turn | `src/three/splat.ts` |
| In your room | Stills from the WebXR viewer on a laptop | `public/media/room-*` |
| Intent | One sentence typed, an example `experience.json` assembled, its steps as a timeline | `src/main.ts` |
| Frontier, credits | The new models with dates; team; the people in the clips | `index.html` |

## Media

`public/media` holds the web encodes (each file under 2 MB, about 8 MB in all); raw renders land in
`public/media-staging` (gitignored, never built). Sources and licenses: `public/assets/CREDITS.md`. Public figures and
private (family) dreams never appear here (`NOT_ON_SITE` in `src/config.ts`; the bridge already leaves out held ones).

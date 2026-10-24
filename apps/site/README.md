# Lucid Dreams: the site

The public page for Lucid Dreams: one dark, scroll-driven page with real Gaussian splat people rendered live in the
browser (three.js 0.186.1 + Spark 2.4.0, the same versions as `apps/webxr`). Vite + TypeScript, no framework.

## Run

```bash
npm --prefix apps/site install
npm --prefix apps/site run dev        # http://localhost:5190
```

## Build

```bash
npm --prefix apps/site run build      # typechecks, then writes apps/site/dist
npm --prefix apps/site run preview    # serves dist on :5190
```

`dist/` is static and uses relative paths, so it can be served from any host or subfolder. Nothing is deployed.

## Swap in a real person

Everything that changes lives in `src/config.ts`. Put the person's `.spz` frames under `public/people/` (not
`public/dreams/`: the repo's `.gitignore` ignores every folder named `dreams/`) and change one line:

```ts
frames: ["people/synthetic-test.spz"],                 // a still person
frames: sequence("people/curry-jumper-01/%06d.spz", 121), // a replay, played at `fps`
```

Height, framing and the "% seen" number are measured from the splats. If the bundle has reality frames
(`%06d.reality.spz`) and `metrics.seenFraction`, set `reality` and `seenFraction` too, and the Honesty section shows
the pipeline's real tint instead of the estimate. `DEMO_URL` turns on the hero's "Watch the demo" link.

Keep the frames small: every frame is downloaded by every visitor (the sample is 167 KB; a 300k-Gaussian frame is
about 4 MB as SPZ).

## What's where

| File | What |
| --- | --- |
| `index.html` | All the copy, as plain HTML (reads fine without JavaScript) |
| `src/main.ts` | Load sequence, scroll reveals, sticky-section progress, the intent typer, lazy 3D mounting |
| `src/three/person.ts` | Loads a person and runs every Gaussian through one Spark dyno: the rise-from-the-floor reveal, the shrink-to-points step, the reality-check tint |
| `src/three/hero.ts` | The hero: the person rises, then turns slowly; framed inside `#hero-figure` by an off-axis projection |
| `src/three/how.ts` | How it works: 48 camera frustums (3 rings x 16 at -10, 15, 35 degrees), the Gaussians, then life-size at eye height |
| `src/three/chess.ts` | The Play section's real-size board; scrolling plays e2-e4 |
| `src/three/honesty.ts` | Reality check on a turning person |
| `public/assets/CREDITS.md` | Third-party assets and licenses |

Each 3D section loads when it's a screen away and only renders while on screen. Without WebGL2, or if a file fails,
the page drops the canvases and the type stands on its own.

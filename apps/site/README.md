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

## Real people

The hero, How it works and Honesty show the real `jump-shot` replay, and the Uses reel plays the three best real
dreams, all read at runtime from the bridge (`apps/web` on the Mac, `GET /api/dreams` and `/dreams/<id>/...`, open
CORS). Nothing heavy is committed. Everything that changes lives in `src/config.ts`:

- `HERO_DREAM`: the replay in the hero (never a public figure). It plays at most `MAX_FRAMES` of its frames (every
  other frame of 121, about 285k Gaussians each); phones and the sections further down hold its first frame only.
- `BRIDGE_URL`: `VITE_BRIDGE_URL`, else this page's host on port 5170 (for a page served over http on the Mac or its
  Wi-Fi, e.g. `npm --prefix apps/site run dev` next to the bridge).
- `NOT_ON_SITE`: ids that never appear (public figures); private dreams (a family's) never do either.
- `CREDITS`: the credit line under each reel dream.

Without a bridge (a static host, `file://`), the page shows the committed sample (`public/people/synthetic-test.spz`)
and hides the reel. Height, framing and the "% seen" number are measured from the splats; a real bundle's reality
frames and `metrics.seenFraction` drive the Honesty section. `DEMO_URL` turns on the hero's "Watch the demo" link.

## What's where

| File | What |
| --- | --- |
| `index.html` | All the copy, as plain HTML (reads fine without JavaScript) |
| `src/main.ts` | Load sequence, scroll reveals, sticky-section progress, the intent typer, the reel, lazy 3D mounting |
| `src/people.ts` | Real people from the bridge: the hero's replay (or the sample), and the dreams the reel may show |
| `src/three/person.ts` | Loads a person and runs every Gaussian through one Spark dyno: the rise-from-the-floor reveal, the shrink-to-points step, the reality-check tint |
| `src/three/hero.ts` | The hero: the person rises, then turns slowly; framed inside `#hero-figure` by an off-axis projection |
| `src/three/how.ts` | How it works: 48 camera frustums (3 rings x 16 at -10, 15, 35 degrees), the Gaussians, then life-size at eye height |
| `src/three/chess.ts` | The Play section's real-size board; scrolling plays e2-e4 |
| `src/three/honesty.ts` | Reality check on a turning person |
| `public/assets/CREDITS.md` | Third-party assets and licenses |

Each 3D section loads when it's a screen away and only renders while on screen. Without WebGL2, or if a file fails,
the page drops the canvases and the type stands on its own.

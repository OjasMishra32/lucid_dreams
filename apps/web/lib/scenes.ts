import "server-only";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DREAMS_DIR, listReady, readDream } from "./bridge/dreams";
import type { Dream } from "./dream";
import { mediaUrl } from "./present";

// Every scene the product has, once each: what you do, with whom, and the one bundle that is that person in the demo.
// The home page shows exactly these (never two of the same person); a scene whose bundle isn't on this Mac is left out.

export type SceneGroup = "learn" | "play" | "relive" | "talk";

export interface SceneDef {
  key: string;
  group: SceneGroup;
  ids: string[]; // the bundle to show, best first
  title: string;
  said: string; // the sentence that makes it
  what: string; // what happens, in one line
  open: string; // the WebXR viewer's query
  image?: string; // a render of the world, for scenes that are more than the person
  label?: string; // public figures: who they are not
  credit?: string;
}

export const SCENES: SceneDef[] = [
  { key: "dance", group: "learn", ids: ["dance-01"], title: "Studio dance", said: "Teach me this routine step by step.", what: "Each step slowed down, glowing targets for your hands, then your turn. Your own ghost dances beside her.", open: "dream=dance-01", credit: "Antoni Shkraba, Pexels" },
  { key: "taichi", group: "learn", ids: ["taichi-01"], title: "Tai chi", said: "Teach me this sequence slowly.", what: "Follow along at half speed, scored against the clip's own 22 joints.", open: "dream=taichi-01", credit: "K / @kelly, Pexels" },
  { key: "golf", group: "learn", ids: ["golf-01"], title: "Golf swing", said: "Slow down this swing and teach it to me.", what: "A 7-iron in your hands and his tempo against yours: backswing to downswing, three to one.", open: "dream=golf-01", credit: "Be The Observer, Pexels" },
  { key: "guitar", group: "learn", ids: ["guitar-01"], title: "Guitar", said: "Teach me this strum pattern.", what: "A guitar at your waist, chords along the neck, a strum lane timed from his own audio.", open: "dream=guitar-01", credit: "Khanh Hoang Minh 2, Pexels" },
  { key: "jumpshot", group: "learn", ids: ["lebron-shot"], title: "LeBron's jump shot", said: "Teach me this jump shot.", what: "The real ball in his hands, a regulation hoop where he aims. Pass to him and he shoots.", open: "dream=lebron-shot", label: "His likeness, from his footage. Not affiliated." },
  { key: "chess-carlsen", group: "play", ids: ["magnus-carlsen-uika-360"], title: "Chess with Magnus", said: "Play chess with me.", what: "Across a walnut table on your floor. He shakes your hand, thinks, reaches, presses the clock.", open: "mode=chess&strength=carlsen", image: "/media/world-chess-magnus.jpg", label: "Stockfish at Carlsen's peak rating. Not affiliated." },
  { key: "chess-fischer", group: "play", ids: ["bobby-fischer-uika"], title: "Chess with Bobby Fischer", said: "Play chess with me.", what: "1972's peak, at your table. He opens with his real repertoire and never says a word.", open: "mode=chess&strength=fischer", image: "/media/world-chess-bobby.jpg", label: "Stockfish at Fischer's peak rating. Not affiliated." },
  { key: "tennis", group: "play", ids: ["roger-federer-uika"], title: "Tennis with Federer", said: "Play a set with me.", what: "He meets you at the net, shakes your hand, then serves flat, slice and kick on full-size grass.", open: "mode=tennis", image: "/media/world-tennis.jpg", label: "His likeness. AI opponent, not affiliated." },
  { key: "replay", group: "relive", ids: ["jump-shot-hq"], title: "A jump shot, frozen", said: "Let me walk around it.", what: "The moment itself, life size on your floor. Freeze it at the top and walk all the way round.", open: "dream=jump-shot-hq", credit: "Pexels" },
  { key: "grandma", group: "talk", ids: ["ian-grandma"], title: "Sitting with Grandma", said: "I just want to sit with her.", what: "Ian's grandmother, rebuilt from a family video, sitting with you. Speak to her and she answers in Vietnamese, in her own voice.", open: "dream=ian-grandma", label: "Shown with her family's permission. Every reply is labelled AI voice." },
  { key: "vishal", group: "talk", ids: ["vishal-lhm", "vishal-head", "vishal"], title: "Talk with Vishal", said: "Stay and talk with me.", what: "He stands in your room and looks at you. Ask him anything; he answers in his own cloned voice.", open: "dream=vishal-lhm", label: "With his consent. Every reply is labelled AI voice." },
];

export interface SceneCard {
  key: string;
  group: SceneGroup;
  title: string;
  said: string;
  what: string;
  open: string;
  label: string | null;
  credit: string | null;
  video: string | null; // the bundle's 360 orbit, playing
  poster: string | null;
  image: string | null;
}

/** The scenes this Mac can show, one bundle each. Held bundles count for play scenes (they run in the headset by id). */
export function scenes(): SceneCard[] {
  const ready = new Map(listReady().map((d) => [d.id, d]));
  const out: SceneCard[] = [];
  for (const s of SCENES) {
    let d: Dream | null = null;
    for (const id of s.ids) {
      d = ready.get(id) ?? (s.image ? readDream(id) : null);
      if (d) break;
    }
    if (!d) continue;
    // a talking scene shows once its person really answers (the bundle says so); until then it isn't on the page
    if (s.group === "talk" && !(d as Dream & { talk?: unknown }).talk) continue;
    const has = (f?: string | null) => !!f && existsSync(join(DREAMS_DIR, d!.id, f));
    out.push({
      key: s.key,
      group: s.group,
      title: s.title,
      said: s.said,
      what: s.what,
      open: s.key === "vishal" ? `dream=${encodeURIComponent(d.id)}` : s.open,
      label: s.label ?? null,
      credit: s.credit ?? null,
      video: !s.image && has(d.preview) ? mediaUrl(d, d.preview) : null,
      poster: has(d.thumb) ? mediaUrl(d, d.thumb) : null,
      image: s.image ?? null,
    });
  }
  return out;
}

export interface MeasuredRow {
  id: string;
  name: string;
  viewsPsnr: number | null;
  viewsSsim: number | null;
  realPsnr: number | null;
  seen: number | null;
  gaussians: number | null;
  frames: number;
}

/** The replays' own measured numbers (dream.json metrics.reconstruction), never more than they say. */
export function measured(): MeasuredRow[] {
  const names: Record<string, string> = { "dance-01": "Studio dance", "taichi-01": "Tai chi", "golf-01": "Golf swing", "guitar-01": "Guitar", "lebron-shot": "LeBron's jump shot", "jump-shot-hq": "Jump shot" };
  const rows: MeasuredRow[] = [];
  for (const id of Object.keys(names)) {
    const d = readDream(id);
    if (!d) continue;
    const r = (d.metrics as unknown as { reconstruction?: { viewsPsnr?: number; viewsSsim?: number; realPsnr?: number } } | undefined)?.reconstruction;
    rows.push({
      id,
      name: names[id],
      viewsPsnr: r?.viewsPsnr ?? d.metrics?.psnr ?? null,
      viewsSsim: r?.viewsSsim ?? d.metrics?.ssim ?? null,
      realPsnr: r?.realPsnr ?? null,
      seen: d.metrics?.seenFraction ?? null,
      gaussians: d.frames?.gaussiansPerFrame ?? null,
      frames: d.frameCount,
    });
  }
  return rows;
}

/** The hero: one frame of the dancer, and its Reality check twin. */
export function heroFrames(): { frame: string; reality: string | null; count: number | null; seen: number | null; views: number | null } | null {
  const d = readDream("dance-01");
  if (!d?.frames?.spz) return null;
  const f = d.frames;
  const first = (pattern: string) => `${f.dir}/${pattern.replace("%06d", "000000")}`;
  if (!existsSync(join(DREAMS_DIR, d.id, first(f.spz!)))) return null;
  const reality = (f as { reality?: string | null }).reality;
  return {
    frame: mediaUrl(d, first(f.spz!))!,
    reality: reality && existsSync(join(DREAMS_DIR, d.id, first(reality))) ? mediaUrl(d, first(reality)) : null,
    count: f.gaussiansPerFrame ?? null,
    seen: d.metrics?.seenFraction ?? null,
    views: d.metrics?.views ?? null,
  };
}

/** 4DAnyone's rig for the hero's clip, as the site exported it (public/media/cameras-dance.json). */
export function rigCameras(): unknown[] {
  try {
    const p = join(process.cwd(), "public", "media", "cameras-dance.json");
    return (JSON.parse(readFileSync(p, "utf8")) as { cameras: unknown[] }).cameras;
  } catch {
    return [];
  }
}

/** The cast for the live 3D line: every public replay in the library, one frame each from the middle of their move. */
export function castCards(): { id: string; frame: string; name: string; said: string; what: string }[] {
  const ready = new Map(listReady().map((d) => [d.id, d]));
  const order = ["dance-01", "taichi-01", "golf-01", "lebron-shot", "guitar-01", "jump-shot-hq", "ian-grandma"];
  const out: { id: string; frame: string; name: string; said: string; what: string }[] = [];
  for (const id of order) {
    const d = ready.get(id);
    const f = d?.frames;
    if (!d || !f?.spz || d.kind !== "replay") continue;
    const at = `${f.dir}/${f.spz.replace("%06d", String(Math.floor(d.frameCount * 0.45)).padStart(6, "0"))}`;
    if (!existsSync(join(DREAMS_DIR, d.id, at))) continue;
    const s = SCENES.find((x) => x.ids.includes(id));
    out.push({ id, frame: mediaUrl(d, at)!, name: s?.title ?? d.name, said: s?.said ?? "", what: s?.what ?? "" });
  }
  return out;
}

/** Real gameplay recorded from the app (public/media/play-*.mp4), the ones that exist. */
export function playClips(): { key: string; title: string; line: string; src: string; poster: string | null }[] {
  const all = [
    { key: "tennis", title: "Tennis", line: "A rally with Federer on full-size grass. His strokes come from real tennis footage." },
    { key: "chess", title: "Chess", line: "Magnus thinks, reaches across the board, moves his piece and presses the clock." },
    { key: "basketball", title: "Basketball", line: "LeBron's real jump shot, with the ball tracked in 3D and a regulation hoop." },
    { key: "golf", title: "Golf", line: "A slow-motion swing, step by step, with his tempo measured against yours." },
    { key: "guitar", title: "Guitar", line: "A strum lesson, timed from the teacher's own audio." },
    { key: "taichi", title: "Tai chi", line: "Follow the form at half speed, scored against the clip's own joints." },
  ];
  const dir = join(process.cwd(), "public", "media");
  return all
    .filter((c) => existsSync(join(dir, `play-${c.key}.mp4`)))
    .map((c) => ({ ...c, src: `/media/play-${c.key}.mp4`, poster: existsSync(join(dir, `play-${c.key}.jpg`)) ? `/media/play-${c.key}.jpg` : null }));
}

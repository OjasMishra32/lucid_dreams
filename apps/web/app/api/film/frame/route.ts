import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// The film's motion graphics, rendered frame by frame (app/film): each frame lands here as a JPEG, and "done" encodes
// them into ~/Downloads/lucid-video/motion/<scene>.mp4 (H.264, 60 fps) for the edit. Development only: the live site
// never writes files.

export const dynamic = "force-dynamic";

const OUT = join(homedir(), "Downloads", "lucid-video", "motion");
const scene = (s: string | null) => (s && /^[a-z0-9-]{1,40}$/.test(s) ? s : null);

export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") return new Response("Not found", { status: 404 });
  const url = new URL(req.url);
  const name = scene(url.searchParams.get("scene"));
  if (!name) return new Response("bad scene", { status: 400 });
  const dir = join(OUT, name);
  const step = url.searchParams.get("do");
  if (step === "start") {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return Response.json({ ok: true, dir });
  }
  if (step === "done") {
    const fps = Number(url.searchParams.get("fps")) || 60;
    const out = join(OUT, `${name}.mp4`);
    const code = await new Promise<number>((resolve) => {
      const p = spawn("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(dir, "%05d.jpg"),
        "-c:v", "libx264", "-preset", "slow", "-crf", "12", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
      p.on("close", (c) => resolve(c ?? 1));
      p.on("error", () => resolve(1));
    });
    if (code === 0) rmSync(dir, { recursive: true, force: true });
    return Response.json({ ok: code === 0, out });
  }
  const i = Number(url.searchParams.get("i"));
  if (!Number.isInteger(i) || i < 0 || i > 99999) return new Response("bad frame", { status: 400 });
  writeFileSync(join(dir, `${String(i).padStart(5, "0")}.jpg`), Buffer.from(await req.arrayBuffer()));
  return Response.json({ ok: true });
}

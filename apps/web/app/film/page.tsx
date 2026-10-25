import type { Metadata } from "next";
import Film from "@/components/film/Film";
import { heroFrames, rigCameras, vishalPipeline } from "@/lib/scenes";

// The film's motion graphics (demo/video.md, Act 3 and the title cards), one scene at a time:
// /film?scene=cameras plays it, /film?scene=cameras&capture renders it frame by frame to
// ~/Downloads/lucid-video/motion/cameras.mp4 (development only). Unlinked from the site.

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Film", robots: { index: false, follow: false } };

export default function FilmPage() {
  const hero = heroFrames();
  const v = vishalPipeline();
  return (
    <Film
      data={{
        frame: hero?.frame ?? null,
        reality: hero?.reality ?? null,
        seen: hero?.seen ?? null,
        count: hero?.count ?? null,
        cameras: rigCameras(),
        clip: "/media/input-dance.mp4",
        overdraw: "/media/overdraw.bin",
        vishal: { avatar: v.avatar, frames: v.frames, env: v.voice.env, talk: v.talk, facts: v.facts },
      }}
    />
  );
}

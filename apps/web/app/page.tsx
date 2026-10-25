import HomeStory from "@/components/home/HomeStory";
import HomeMotion from "@/components/home/HomeMotion";
import PlayReel from "@/components/home/PlayReel";
import Pipeline from "@/components/home/Pipeline";
import SceneGallery, { type GroupCopy } from "@/components/home/SceneGallery";
import { heroFrames, playClips, rigCameras, scenes, vishalPipeline } from "@/lib/scenes";
import type { RigCamera } from "@/lib/three/story";
import TechnologySection from "@/components/tech/TechnologySection";
import HeadsetStage from "@/components/tech/HeadsetStage";
import MakeDream from "@/components/MakeDream";
import "./home.css";

export const dynamic = "force-dynamic";

const GROUPS: GroupCopy[] = [
  { key: "learn", eyebrow: "Learn", intro: "They play the move at full size. Turn on Lesson to go step by step." },
  { key: "play", eyebrow: "Play", intro: "Chess and tennis at real size. Legends are labeled likenesses and never speak." },
  { key: "relive", eyebrow: "Moments", intro: "The moment itself. Pause it and walk around." },
  { key: "talk", eyebrow: "Talk", intro: "Talk to them and they answer in their own voice." },
];

export default function Home() {
  const hero = heroFrames();
  const cards = scenes();
  const cams = rigCameras() as RigCamera[];
  const clips = playClips();
  const pipe = vishalPipeline();

  return (
    <div className="home">
      <HomeStory
        frame={hero?.frame ?? null}
        reality={hero?.reality ?? null}
        cameras={cams}
        seen={hero?.seen ?? null}
        views={hero?.views ?? null}
        poster="/media/hero-dance.jpg"
      />

      <section id="headset" className="tech t-headset" aria-label="Meta Quest 3S">
        <HeadsetStage person={hero?.frame ?? null} />
      </section>

      {clips.length > 0 && (
        <section className="play-section" aria-labelledby="play-title">
          <h2 id="play-title" className="section-head reveal">Recorded in the headset.</h2>
          <div className="reveal"><PlayReel clips={clips} /></div>
        </section>
      )}

      <div id="scenes" className="scenes">
        <SceneGallery groups={GROUPS} cards={cards} />
      </div>

      <Pipeline data={pipe} />

      <TechnologySection />

      <section id="make" className="make-x" aria-labelledby="make-title">
        <h2 id="make-title" className="section-head">Make your own</h2>
        <p className="section-sub">Upload a video or photos and say what you want to do with them.</p>
        <div className="make-x-form"><MakeDream /></div>
        <p className="credits-x">
          Built with 4DAnyone (Aug 2026), LHM++, UIKA, GVHMR, Gemini, gsplat and Spark. Quest 3S model by OG_MATTER on
          Sketchfab (CC BY 4.0). Source on <a href="https://github.com/OjasMishra32/lucid_dreams">GitHub</a>.
        </p>
      </section>
      <HomeMotion />
    </div>
  );
}

import HomeStory from "@/components/home/HomeStory";
import HomeMotion from "@/components/home/HomeMotion";
import PlayReel from "@/components/home/PlayReel";
import SceneGallery, { type GroupCopy } from "@/components/home/SceneGallery";
import { heroFrames, measured, playClips, rigCameras, scenes } from "@/lib/scenes";
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
  const rows = measured();
  const cams = rigCameras() as RigCamera[];
  const clips = playClips();
  const lead = rows.find((r) => r.id === "dance-01") ?? rows[0];

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

      {/* one video becomes 48: pinned while you scroll, the clip steps aside and the wall of views assembles */}
      <section id="how" className="pipe-story" data-scrub="track" aria-labelledby="how-title">
        <div className="pipe-sticky">
          <h2 id="how-title" className="section-head">How it works</h2>
          <div className="pipe-stage">
            <div className="pipe-wall">
              <video src="/media/wall-dance.mp4" poster="/media/wall-dance.jpg" muted loop playsInline autoPlay preload="none" aria-hidden="true" />
              <div className="pipe-cells" aria-hidden="true">
                {Array.from({ length: 48 }, (_, i) => (
                  <i key={i} style={{ ["--s" as string]: (0.36 + (((i % 16) * 3 + Math.floor(i / 16)) / 48) * 0.36).toFixed(3) }} />
                ))}
              </div>
            </div>
            <div className="pipe-input">
              <video src="/media/input-dance.mp4" poster="/media/input-dance.jpg" muted loop playsInline autoPlay preload="none" aria-hidden="true" />
            </div>
          </div>
          <p className="pipe-cap cap-1"><b>One video.</b> Five seconds, one person, one camera. A phone works.</p>
          <p className="pipe-cap cap-2"><b>48 views.</b> 4DAnyone generates the other angles, synced frame by frame.</p>
        </div>
      </section>

      <section className="how">
        <ul className="stats">
          <li className="reveal"><b data-count="1">1</b><span>video in</span></li>
          <li className="reveal"><b data-count={hero?.views ?? 48}>{hero?.views ?? 48}</b><span>generated views</span></li>
          <li className="reveal"><b data-count={lead?.gaussians ?? 289466}>{(lead?.gaussians ?? 289466).toLocaleString("en-US")}</b><span>Gaussians per frame</span></li>
          <li className="reveal"><b data-count={lead?.frames ?? 121}>{lead?.frames ?? 121}</b><span>frames, ~1 min each on a B200</span></li>
        </ul>
      </section>

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

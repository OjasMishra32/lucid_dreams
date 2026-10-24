import Link from "next/link";
import HomeStory from "@/components/home/HomeStory";
import SceneGallery, { type GroupCopy } from "@/components/home/SceneGallery";
import { MeasuredTable, TruthSlider } from "@/components/home/Measured";
import { ViewerLink } from "@/components/ViewInRoom";
import { heroFrames, measured, rigCameras, scenes } from "@/lib/scenes";
import type { RigCamera } from "@/lib/three/story";
import "./home.css";

export const dynamic = "force-dynamic";

// What the people are built on, and when it became public (the theme: fresh off the frontier).
const BUILT_ON = [
  { name: "4DAnyone", when: "August 2026 · Ant Research", what: "Turns one casual video into consistent 360-degree video from 48 cameras. The heart of every replay." },
  { name: "LHM++", when: "March 2026", what: "Builds an animatable full-body person from many photos. The chess and tennis legends." },
  { name: "UIKA", when: "CVPR 2026", what: "Rebuilds a head from a photo collection, so a face holds up at arm's length." },
  { name: "GVHMR", when: "2024", what: "Reads real human motion from footage: the joints you follow, every tennis stroke." },
  { name: "Gemini", when: "Google", what: "Turns your one sentence into a plan: a lesson, a game, company." },
  { name: "Spark and WebXR", when: "Quest 3S browser", what: "Draws hundreds of thousands of Gaussians a frame, life size, in passthrough." },
];

export default function Home() {
  const hero = heroFrames();
  const cards = scenes();
  const rows = measured();
  const cams = rigCameras() as RigCamera[];
  const lead = rows.find((r) => r.id === "dance-01") ?? rows[0];
  const card = (key: string) => cards.find((c) => c.key === key);

  const groups: GroupCopy[] = [
    {
      key: "learn",
      eyebrow: "Lessons",
      headline: "A teacher who waits for you.",
      intro: "Every lesson slows the move down, one step at a time, then holds still while you try it. Follow along and you are scored against the clip's own joints.",
      banner: { video: card("dance")?.video ?? null },
    },
    {
      key: "play",
      eyebrow: "Games",
      headline: "Your move.",
      intro: "Real games at real size: chess at the peak ratings of two legends, and a set of tennis on full-size grass. Every legend is a likeness, labelled as one, and never speaks.",
      banner: { image: card("chess-carlsen")?.image ?? null },
    },
    {
      key: "relive",
      eyebrow: "Moments",
      headline: "Stop time. Walk around it.",
      intro: "A replay is the moment itself, life size on your floor. Freeze it at the top of the jump and see what the one camera never could.",
      banner: null,
    },
    {
      key: "talk",
      eyebrow: "Company",
      headline: "Someone real, answering you.",
      intro: "He stands in your room and looks at you. Ask him anything, and he answers in his own voice, cloned with his permission. Every reply is labelled as AI.",
      banner: card("vishal")?.video ? { video: card("vishal")!.video } : null,
    },
  ];

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

      <section className="intro">
        <p>
          Drop in a video of anyone and say what you want to do with them. Minutes later they are standing in your room,
          life size and in 3D.
        </p>
        <p>
          Learn their move. Play them at their game. <span>Or simply spend time with them.</span>
        </p>
      </section>

      <div id="scenes" className="scenes">
        <SceneGallery groups={groups} cards={cards} />
      </div>

      <section className="how">
        <h2 className="section-head">How a video becomes a person.</h2>
        <div className="how-tiles">
          <figure className="tile">
            <div className="tile-media"><video src="/media/input-dance.mp4" poster="/media/input-dance.jpg" muted loop playsInline autoPlay preload="none" aria-hidden="true" /></div>
            <figcaption><b>One video.</b> Five seconds of one person, head to toe, from a single camera. A phone is enough.</figcaption>
          </figure>
          <figure className="tile tile-wide">
            <div className="tile-media"><video src="/media/wall-dance.mp4" poster="/media/wall-dance.jpg" muted loop playsInline autoPlay preload="none" aria-hidden="true" /></div>
            <figcaption><b>Forty-eight views.</b> 4DAnyone imagines the same moment from a dome of cameras around her, every frame in step.</figcaption>
          </figure>
        </div>
        <ul className="stats">
          <li><b>1</b><span>video in</span></li>
          <li><b>{hero?.views ?? 48}</b><span>views imagined</span></li>
          <li><b>{lead?.gaussians ? lead.gaussians.toLocaleString("en-US") : "289,466"}</b><span>Gaussians a frame</span></li>
          <li><b>{lead?.frames ?? 121}</b><span>frames, about a minute each on a B200</span></li>
        </ul>
        <p className="how-foot"><Link href="/live" className="link-x">Watch a run on HiPerGator</Link></p>
      </section>

      <section className="truth-section">
        <h2 className="section-head">Measured, not claimed.</h2>
        <p className="section-sub">The same camera at the same instant. Drag between the real frame and our render.</p>
        <TruthSlider real="/media/truth-dance-real.jpg" render="/media/truth-dance-render.jpg" />
        {rows.length > 0 && (
          <div className="measured-wrap">
            <MeasuredTable rows={rows} />
            <p className="fine">
              Views PSNR and SSIM compare our render with the 4DAnyone views it was fitted to (every eighth of 48 cameras,
              the median over the frames; none held out). Seen is the share of Gaussians the real camera could see. The rest
              is imagined, and the Reality check shows it in blue.
            </p>
          </div>
        )}
      </section>

      <section className="built">
        <h2 className="section-head">Built on this year&rsquo;s research.</h2>
        <ul className="built-grid">
          {BUILT_ON.map((b) => (
            <li key={b.name}>
              <h3>{b.name}</h3>
              <p className="built-when">{b.when}</p>
              <p>{b.what}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="closer-x">
        <h2>Who will you bring into the room?</h2>
        <div className="closer-buttons">
          <Link href="/new" className="pill">Make a dream</Link>
          <ViewerLink query="mode=tennis" className="pill pill-quiet">Play Federer</ViewerLink>
        </div>
      </section>
    </div>
  );
}

import Link from "next/link";
import { leadDream, listReady } from "@/lib/bridge/dreams";
import { dreamFile, formatCount, heightM } from "@/lib/dream";
import { seenPercent } from "@/lib/format";

export const dynamic = "force-dynamic";

export default function Home() {
  const dreams = listReady();
  const lead = leadDream(dreams);
  const seen = lead ? seenPercent(lead) : null;
  const height = lead ? heightM(lead) : null;
  // Real numbers for "How it works", from the newest real dream that has them.
  const real = dreams.filter((d) => !d.id.startsWith("synthetic") && d.frameCount >= 121 && d.metrics?.views);
  const views = real.find((d) => d.metrics?.views)?.metrics?.views ?? null;
  const gaussians = real.find((d) => d.frames?.gaussiansPerFrame)?.frames?.gaussiansPerFrame ?? null;
  const frames = real.find((d) => d.frameCount > 1)?.frameCount ?? null;

  return (
    <>
      <section className="hero">
        <p className="eyebrow">Lucid Dreams</p>
        <h1 className="display">
          Anyone from any video,
          <br />
          standing in your room.
        </h1>
        <p className="lede">
          One clip becomes a photoreal, life-size person you can walk all the way around. Freeze them, slow them
          down, and learn the move from them.
        </p>
        <div className="hero-actions">
          <Link href="/new" className="btn">Make a dream</Link>
          {dreams.length > 0 && <Link href="/library" className="more">See the library</Link>}
        </div>
      </section>

      {lead && (
        <section className="feature">
          <Link href={`/library/${encodeURIComponent(lead.id)}`} className="frame" aria-label={`${lead.name}: see the dream`}>
            <video
              src={dreamFile(lead.id, lead.preview!)}
              poster={lead.thumb ? dreamFile(lead.id, lead.thumb) : undefined}
              autoPlay
              muted
              loop
              playsInline
            />
          </Link>
          <p className="feature-caption">{lead.name}. Rebuilt from one video, walked all the way around.</p>
          <p className="feature-stats num">
            {height && <span>{height.toFixed(2)} m tall, life size</span>}
            {lead.metrics?.views ? <span>{lead.metrics.views} views imagined</span> : null}
            {lead.frameCount ? <span>{lead.frameCount} frames in 3D</span> : null}
          </p>
        </section>
      )}

      <section className="band">
        <div className="band-head">
          <h2 className="section-title">From one clip to your room.</h2>
          <p>No studio, no camera rig. A phone video is enough.</p>
        </div>
        <div className="wrap steps">
          <div className="step">
            <p className="step-n">1</p>
            <h3>Drop in a clip.</h3>
            <p>Five seconds of one person, head to toe, with the camera held still. Or a single photo.</p>
          </div>
          <div className="step">
            <p className="step-n">2</p>
            <h3>We imagine every angle.</h3>
            <p>
              4DAnyone turns your one video into {views ? `${views}` : "dozens of"} synchronized views, then we rebuild
              the person in 3D, frame by frame{gaussians ? `: ${formatCount(gaussians)} Gaussians in every one` : ""}.
            </p>
          </div>
          <div className="step">
            <p className="step-n">3</p>
            <h3>They stand in your room.</h3>
            <p>
              Life size on your real floor in Quest passthrough{frames ? `, all ${frames} frames of the move` : ""}. Walk
              around them, freeze them, play them at quarter speed.
            </p>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap honest">
          <div>
            <h2 className="section-title">Seen, and imagined.</h2>
            <p>
              A camera only ever sees one side of a person. Lucid Dreams imagines the rest, and never pretends
              otherwise: every dream can show you exactly which parts the camera saw.
            </p>
          </div>
          {seen !== null && (
            <div>
              <p className="big-num">{seen}%</p>
              <p className="big-num-label">of {lead!.name} was seen by the camera.</p>
            </div>
          )}
        </div>
      </section>

      <section className="closer">
        <h2 className="section-title">Who will you bring into the room?</h2>
        <Link href="/new" className="btn">Make a dream</Link>
      </section>
    </>
  );
}

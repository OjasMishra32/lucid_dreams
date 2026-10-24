import Image from "next/image";
import Link from "next/link";
import SiteLink from "@/components/SiteLink";
import { listReady } from "@/lib/bridge/dreams";
import { intentOf } from "@/lib/bridge/experience";
import { formatCount, type Dream } from "@/lib/dream";
import { seenPercent } from "@/lib/format";
import { MODE_LABEL, asSentence, displayName, heroOrder, legendNote, mediaUrl, modeOf } from "@/lib/present";

export const dynamic = "force-dynamic";

export default function Home() {
  const dreams = listReady();
  // The lineup: the best real people, the best in the middle and in motion, the rest standing either side.
  const best = heroOrder(dreams).slice(0, 5);
  const lineup = [best[3], best[1], best[0], best[2], best[4]].filter((d): d is Dream => Boolean(d));
  const lead = best[0] ?? null;
  const seen = lead ? seenPercent(lead) : null;
  // Real numbers for "How it works", from the people in the library.
  const views = best.find((d) => d.metrics?.views)?.metrics?.views ?? null;
  const gaussians = best.find((d) => d.frames?.gaussiansPerFrame)?.frames?.gaussiansPerFrame ?? null;
  const frames = best.find((d) => d.frameCount > 1)?.frameCount ?? null;

  // "Say what you want": real sentences from the library, one per kind of thing you can do
  const said = (["teach", "play", "companion"] as const)
    .map((mode) => {
      const d = dreams.find((x) => modeOf(x, intentOf(x)) === mode && intentOf(x));
      return d ? { mode, d, sentence: asSentence(intentOf(d)!) } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return (
    <>
      <section className="home-hero">
        <p className="eyebrow">Lucid Dreams</p>
        <h1 className="display">
          Anyone from any video,
          <br />
          standing in your room.
        </h1>
        <p className="lede">
          One clip or photo, and one sentence of what you want. They arrive life size in your headset, doing it with you.
        </p>
        <div className="hero-actions">
          <Link href="/new" className="btn">Make a dream</Link>
          <Link href="/library" className="more">Meet them</Link>
        </div>
      </section>

      {lineup.length > 0 && (
        <section className="lineup" aria-label="People in the library">
          <div className="lineup-row">
            {lineup.map((d) => {
              const role = d === lead ? "lead" : d === best[1] || d === best[2] ? "near" : "";
              const poster = mediaUrl(d, d.thumb);
              return (
                <Link key={d.id} href={`/library/${encodeURIComponent(d.id)}`} className={`person lineup-person ${role}`} aria-label={displayName(d)}>
                  {poster && (
                    <Image src={poster} alt="" fill priority={role === "lead"} sizes={role === "lead" ? "(max-width: 860px) 42vw, 370px" : "(max-width: 860px) 31vw, 290px"} />
                  )}
                  {role === "lead" && d.preview && (
                    <video src={mediaUrl(d, d.preview)!} autoPlay muted loop playsInline preload="auto" aria-hidden="true" className="ready" />
                  )}
                </Link>
              );
            })}
          </div>
          <div className="lineup-floor" aria-hidden="true" />
          <p className="lineup-caption">
            {lineup.length > 1
              ? `${["", "", "Two", "Three", "Four", "Five"][lineup.length]} people, each rebuilt from a single video.`
              : "Rebuilt from a single video."}
          </p>
        </section>
      )}

      {said.length > 0 && (
        <section className="band says-band" aria-labelledby="says-title">
          <div className="band-head">
            <h2 className="section-title" id="says-title">Say what you want.</h2>
            <p>One sentence decides what happens when they arrive.</p>
          </div>
          <ul className="says">
            {said.map(({ mode, d, sentence }) => (
              <li key={mode}>
                <p className="said">&ldquo;{sentence.replace(/\.$/, "")}.&rdquo;</p>
                <div className="says-what">
                  <b>{MODE_LABEL[mode]}</b>
                  <p>{WHAT[mode]}</p>
                  {legendNote(d) && <small>{legendNote(d)}</small>}
                  <Link href={`/library/${encodeURIComponent(d.id)}`} className="more">{displayName(d)}</Link>
                </div>
              </li>
            ))}
          </ul>
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
            <h3>Drop in a clip, and say what you want.</h3>
            <p>Five seconds of one person, head to toe, or a single photo. Then one sentence: &ldquo;teach me this strum,&rdquo; &ldquo;just be with me.&rdquo;</p>
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
              Life size on your real floor in Quest passthrough{frames ? `, all ${frames} frames of the move` : ""}. Gemini
              turns your sentence into what happens next: a lesson step by step, slowed down, with your turn after each.
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
          {seen !== null && lead && (
            <div>
              <p className="big-num">{seen}%</p>
              <p className="big-num-label">of {displayName(lead)} was seen by the camera. The other {100 - seen}% is imagined, and shown in blue when you ask.</p>
            </div>
          )}
        </div>
      </section>

      <section className="closer">
        <h2 className="section-title">Who will you bring into the room?</h2>
        <div className="hero-actions">
          <Link href="/new" className="btn">Make a dream</Link>
          <SiteLink className="more">See what it does</SiteLink>
        </div>
      </section>
    </>
  );
}

const WHAT: Record<"teach" | "play" | "companion", string> = {
  teach: "A lesson. Each step slowed down, then they hold still while you try it.",
  play: "A game of chess across a real-size board on your table. They move their own pieces.",
  companion: "Company. Someone you miss, simply with you, their voice from where they sit.",
};

import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import DreamStage from "@/components/DreamStage";
import DreamExperience from "@/components/DreamExperience";
import QuestUrl from "@/components/QuestUrl";
import RealismPanel from "@/components/RealismPanel";
import { heldIds, readDream } from "@/lib/bridge/dreams";
import { GEMINI_ON, ensureExperience, intentOf } from "@/lib/bridge/experience";
import { onThisMac, publicOrigin, viewerOrigin } from "@/lib/bridge/http";
import { ensureRealism } from "@/lib/bridge/realism";
import { isPrivate, type Dream, type Experience, type ExperienceState, type Strength } from "@/lib/dream";
import { formatDate, seenPercent } from "@/lib/format";
import {
  MODE_LABEL,
  creditOf,
  displayName,
  lineOf,
  madeWith,
  mediaUrl,
  modeOf,
  personFacts,
  publicFigure,
} from "@/lib/present";
import { chessLabel, legendOf } from "@/lib/showcase";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** The dream, if this request may see it: never one held back, and a private one only on this Mac itself. */
async function visible(id: string): Promise<Dream | null> {
  const d = readDream(id);
  if (!d || heldIds().has(d.id)) return null;
  if (isPrivate(d) && !onThisMac(await headers())) return null;
  return d;
}

/** Shared links unfurl with the dream's thumbnail. The bridge has no fixed address, so the base comes from the request. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const d = await visible((await params).id);
  if (!d) return { title: "Not found" };
  const name = displayName(d);
  if (isPrivate(d)) return { title: name, robots: { index: false, follow: false } }; // nothing that unfurls in a share
  const origin = publicOrigin(await headers());
  const legend = legendOf(d.id);
  const description = legend
    ? `Chess across a real-size board. ${chessLabel(legend)}`
    : `${name}, rebuilt in 3D from ${d.kind === "avatar" ? "photos" : "one video"}. Life size, in your room.`;
  const thumb = mediaUrl(d, d.thumb);
  const images = thumb ? [{ url: thumb, alt: name }] : [];
  return {
    title: name,
    description,
    metadataBase: new URL(origin),
    openGraph: { title: name, description, images, type: "video.other" },
    twitter: { card: "summary_large_image", title: name, description, images: images.map((i) => i.url) },
  };
}

export default async function DreamPage({ params }: Props) {
  const d = await visible((await params).id);
  if (!d) notFound();

  const name = displayName(d);
  const legend = legendOf(d.id); // a chess legend: the engine at their peak, labelled as the engine wherever they appear
  const intent = intentOf(d);
  const planned = ensureExperience(d.id);
  const ready = planned.state === "ready" ? planned.experience : null;
  const mode = modeOf(d, intent, ready);
  const experience: ExperienceState =
    legend && ready?.play
      ? { state: "ready", experience: { ...ready, play: { ...ready.play, strength: legend as Strength } } }
      : planned.state === "off" || planned.state === "failed"
        ? fromSentence(d, intent, mode, legend) ?? planned
        : planned;
  const hidden = isPrivate(d); // a family's dream: no share link, no Quest address, no realism check, numbers folded away
  const realism = hidden ? null : ensureRealism(d.id);
  const h = await headers();
  const shareUrl = hidden ? null : `${publicOrigin(h)}/library/${encodeURIComponent(d.id)}`;
  const questUrl = `${viewerOrigin(h)}/?dream=${encodeURIComponent(d.id)}`;
  const seen = seenPercent(d);
  const scores = measured(d);
  const facts = personFacts(d);
  const credit = creditOf(d);
  const preview = mediaUrl(d, d.preview);
  const poster = mediaUrl(d, d.thumb);

  const numbers = (
    <>
      {(scores.length > 0 || facts.length > 0) && (
        <section className="d-band" aria-labelledby="measured">
          <h2 className="d-title" id="measured">{scores.length > 0 ? "Measured on every frame." : "The person."}</h2>
          {scores.length > 0 && (
            <>
              <p className="d-lede">
                Every score compares our render with real frames of the video that were held out of training: what a
                camera actually saw, against what we rebuilt.
              </p>
              <dl className="metrics">
                {scores.map(([label, value, unit, hint]) => (
                  <div className="metric" key={label}>
                    <dt>
                      {label}
                      <span>{hint}</span>
                    </dt>
                    <dd className="num">
                      {value}
                      {unit && <small>{unit}</small>}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}
          {facts.length > 0 && (
            <dl className="specs">
              {facts.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd className="num">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      )}

      {seen !== null && (
        <section className="d-band reality" aria-labelledby="reality">
          <div>
            <h2 className="d-title" id="reality">Seen, and imagined.</h2>
            <p className="d-lede">
              A camera only ever sees one side of a person. The rest, the back and the far side, is imagined, and we
              never pass it off as real: in your room, <b>Reality check</b> tints every imagined part blue.
            </p>
          </div>
          <figure className="reality-fig" aria-label={`${seen}% seen by the camera, ${100 - seen}% imagined`}>
            <div className="reality-bar" aria-hidden="true">
              <span className="seen" style={{ flexGrow: seen }} />
              <span className="imagined" style={{ flexGrow: 100 - seen }} />
            </div>
            <figcaption className="reality-legend">
              <span>
                <b className="num">{seen}%</b>
                seen by the camera
              </span>
              <span className="imagined">
                <b className="num">{100 - seen}%</b>
                imagined
              </span>
            </figcaption>
          </figure>
        </section>
      )}
    </>
  );

  return (
    <div className="wrap detail">
      <Link href="/library" className="back">Library</Link>
      <div className="dstage">
        <div className="dstage-media">
          <DreamStage id={d.id} src={preview} poster={poster} name={name} captions={d.captions ? mediaUrl(d, d.captions) : null} />
        </div>

        <div className="dstage-copy">
          <p className="d-eyebrow">
            <span>{MODE_LABEL[mode]}</span>
            <span aria-hidden="true">·</span>
            <span>{d.kind === "avatar" ? "Can do any move" : "Moves exactly like the clip"}</span>
          </p>
          <h1 className="d-name">{name}</h1>
          <p className="said d-said">{lineOf(d, intent)}</p>
          {legend && <p className="d-legend">{chessLabel(legend)} They never speak.</p>}
          {!legend && publicFigure(d.id) && credit && <p className="d-legend">{credit}</p>}
          {d.createdAt && <p className="d-meta">Made {formatDate(d.createdAt)}</p>}
          <DreamExperience
            id={d.id}
            kind={d.kind}
            name={name}
            durationS={d.durationS}
            shareUrl={shareUrl}
            initial={experience}
            tryOn={GEMINI_ON && !hidden && d.kind === "replay"}
            teacherSrc={preview}
          />
          {!hidden && <QuestUrl url={questUrl} />}
        </div>
      </div>

      {hidden ? (
        <details className="quiet-details">
          <summary>Show details</summary>
          {numbers}
        </details>
      ) : (
        numbers
      )}

      {realism && realism.state !== "off" && (
        <section className="d-band d-realism">
          <RealismPanel id={d.id} initial={realism} />
        </section>
      )}

      <section className="d-band credits" aria-labelledby="credits">
        <h2 className="d-title" id="credits">How it was made.</h2>
        <p>{madeWith(d)}</p>
        {credit && <p>{credit}</p>}
        {legend && <p>{chessLabel(legend)} Their likeness is used for this demo only and never speaks.</p>}
      </section>
    </div>
  );
}

/** Held-out scores, as [label, value, unit, how to read it]. */
function measured(d: Dream): [string, string, string, string][] {
  const m = d.metrics;
  if (!m) return [];
  const out: [string, string, string, string][] = [];
  if (m.psnr != null) out.push(["PSNR", m.psnr.toFixed(1), "dB", "Pixel accuracy. Higher is better."]);
  if (m.ssim != null) out.push(["SSIM", m.ssim.toFixed(3), "", "Structure. 1.000 is identical."]);
  if (m.lpips != null) out.push(["LPIPS", m.lpips.toFixed(3), "", "How different it looks to a network. Lower is better."]);
  return out;
}

/**
 * Until Gemini writes a plan, the sentence alone shapes what happens, exactly as the WebXR viewer reads it
 * (apps/webxr/src/experience.ts, fallbackExperience): a lesson in equal parts at half speed, or a game of chess.
 */
function fromSentence(d: Dream, intent: string | null, mode: string, legend: string | null): ExperienceState | null {
  if (mode === "play") {
    const e: Experience = {
      intent: null,
      mode: "play",
      title: "A game of chess",
      summary: "Seated across a real-size board on your table. They move their own pieces and press the clock.",
      place: "facing",
      play: { game: "chess", strength: (legend ?? "gm") as Strength },
      source: "intent",
    };
    return { state: "ready", experience: e };
  }
  if (mode !== "teach" || !intent || !d.durationS) return null;
  const parts = d.durationS >= 3 ? 3 : 2;
  const len = d.durationS / parts;
  const e: Experience = {
    intent: null, // already said under their name
    mode: "teach",
    title: `The lesson, in ${parts} parts`,
    summary: "Each part plays at half speed, twice, then they hold still while you try it.",
    place: "facing",
    steps: Array.from({ length: parts }, (_, i) => ({
      start: i * len,
      end: (i + 1) * len,
      title: `Part ${i + 1}`,
      tip: i === 0 ? "Watch it slowly, then copy it." : "Same again: watch, then your turn.",
      speed: 0.5,
      repeat: 2,
    })),
    durationS: d.durationS,
    source: "intent",
  };
  return { state: "ready", experience: e };
}

import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import DreamStage from "@/components/DreamStage";
import DreamExperience from "@/components/DreamExperience";
import QuestUrl from "@/components/QuestUrl";
import RealismPanel from "@/components/RealismPanel";
import { heldIds, readDream } from "@/lib/bridge/dreams";
import { GEMINI_ON, ensureExperience } from "@/lib/bridge/experience";
import { onThisMac, publicOrigin, viewerOrigin } from "@/lib/bridge/http";
import { ensureRealism } from "@/lib/bridge/realism";
import { dreamFile, formatCount, heightM, isPrivate, type Dream, type Strength } from "@/lib/dream";
import { formatDate, seenPercent } from "@/lib/format";
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
  if (isPrivate(d)) return { title: d.name, robots: { index: false, follow: false } }; // nothing that unfurls in a share
  const origin = publicOrigin(await headers());
  const legend = legendOf(d.id);
  const description = legend
    ? `Chess across a real-size board. ${chessLabel(legend)}`
    : `${d.name}, rebuilt in 3D from ${d.kind === "avatar" ? "photos" : "one video"}. Life size, in your room.`;
  const images = d.thumb ? [{ url: dreamFile(d.id, d.thumb), alt: d.name }] : [];
  return {
    title: d.name,
    description,
    metadataBase: new URL(origin),
    openGraph: { title: d.name, description, images, type: "video.other" },
    twitter: { card: "summary_large_image", title: d.name, description, images: images.map((i) => i.url) },
  };
}

export default async function DreamPage({ params }: Props) {
  const d = await visible((await params).id);
  if (!d) notFound();

  const legend = legendOf(d.id); // a chess legend: the engine at their peak, labelled as the engine wherever they appear
  const planned = ensureExperience(d.id);
  const experience =
    legend && planned.state === "ready" && planned.experience.play
      ? { ...planned, experience: { ...planned.experience, play: { ...planned.experience.play, strength: legend as Strength } } }
      : planned;
  const hidden = isPrivate(d); // a family's dream: no share link, no Quest address, no realism check, numbers folded away
  const realism = hidden ? null : ensureRealism(d.id);
  const h = await headers();
  const shareUrl = hidden ? null : `${publicOrigin(h)}/library/${encodeURIComponent(d.id)}`;
  const questUrl = `${viewerOrigin(h)}/?dream=${encodeURIComponent(d.id)}`;
  const seen = seenPercent(d);
  const facts = basics(d);
  const fidelity = metrics(d);

  // a private dream's page stays quiet: its numbers only when asked for
  const numbers = (
    <>
      {facts.length > 0 && (
        <>
          <h2>The person</h2>
          <div className="facts">
            {facts.map(([value, label]) => (
              <div className="fact" key={label}>
                <b>{value}</b>
                <span>{label}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {seen !== null && (
        <>
          <h2>Seen, and imagined</h2>
          <div className="facts">
            <div className="fact">
              <b>{seen}%</b>
              <span>seen by the camera</span>
            </div>
            <div className="fact">
              <b>{100 - seen}%</b>
              <span>imagined</span>
            </div>
          </div>
          <p className="note">In your room, turn on Reality check to see every imagined part tinted blue.</p>
        </>
      )}

      {fidelity.length > 0 && (
        <>
          <h2>Fidelity</h2>
          <div className="facts">
            {fidelity.map(([value, label]) => (
              <div className="fact" key={label}>
                <b>{value}</b>
                <span>{label}</span>
              </div>
            ))}
          </div>
          <p className="note">Measured against real frames held out from training, not claimed.</p>
        </>
      )}
    </>
  );

  return (
    <div className="wrap">
      <Link href="/library" className="back">Library</Link>
      <div className="detail">
        <div className="stage-col">
          <DreamStage
            src={d.preview ? dreamFile(d.id, d.preview) : null}
            poster={d.thumb ? dreamFile(d.id, d.thumb) : null}
            name={d.name}
            captions={d.captions ? dreamFile(d.id, d.captions) : null}
          />
        </div>

        <div>
          <p className="detail-kind">{d.kind === "avatar" ? "Avatar · can do any move" : "Replay · moves exactly like the clip"}</p>
          <h1 className="page-title">{d.name}</h1>
          {d.createdAt && <p className="detail-date">Made {formatDate(d.createdAt)}</p>}
          {legend && <p className="detail-legend">{chessLabel(legend)} They never speak.</p>}
          <DreamExperience id={d.id} kind={d.kind} name={d.name} durationS={d.durationS} shareUrl={shareUrl}
            initial={experience}
            tryOn={GEMINI_ON && !hidden && d.kind === "replay"}
            teacherSrc={d.preview ? dreamFile(d.id, d.preview) : null}
          />
          {!hidden && <QuestUrl url={questUrl} />}
          {realism && <RealismPanel id={d.id} initial={realism} />}

          {hidden ? (
            <details className="quiet-details">
              <summary>Show details</summary>
              {numbers}
            </details>
          ) : (
            numbers
          )}
        </div>
      </div>
    </div>
  );
}

function basics(d: Dream): [string, string][] {
  const out: [string, string][] = [];
  const h = heightM(d);
  if (h) out.push([`${h.toFixed(2)} m`, "tall, life size"]);
  if (d.durationS) out.push([`${d.durationS.toFixed(1)} s`, `${d.frameCount} frames at ${d.fps} fps`]);
  if (d.frames?.gaussiansPerFrame) out.push([formatCount(d.frames.gaussiansPerFrame), "Gaussians per frame"]);
  if (d.metrics?.views) out.push([String(d.metrics.views), "views imagined"]);
  return out;
}

function metrics(d: Dream): [string, string][] {
  const m = d.metrics;
  if (!m) return [];
  const out: [string, string][] = [];
  if (m.psnr != null) out.push([`${m.psnr.toFixed(1)} dB`, "PSNR"]);
  if (m.ssim != null) out.push([m.ssim.toFixed(3), "SSIM"]);
  if (m.lpips != null) out.push([m.lpips.toFixed(3), "LPIPS (lower is better)"]);
  return out;
}

import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import DreamStage from "@/components/DreamStage";
import GuidePanel from "@/components/GuidePanel";
import ShareButton from "@/components/ShareButton";
import ViewInRoom, { ViewerLink } from "@/components/ViewInRoom";
import { readDream } from "@/lib/bridge/dreams";
import { ensureGuide } from "@/lib/bridge/guide";
import { publicOrigin } from "@/lib/bridge/http";
import { dreamFile, formatCount, heightM, type Dream } from "@/lib/dream";
import { formatDate, seenPercent } from "@/lib/format";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Shared links unfurl with the dream's thumbnail. The bridge has no fixed address, so the base comes from the request. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const d = readDream((await params).id);
  if (!d) return { title: "Not found" };
  const origin = publicOrigin(await headers());
  const description = `${d.name}, rebuilt in 3D from one video. Life size, in your room.`;
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
  const d = readDream((await params).id);
  if (!d) notFound();

  const guide = ensureGuide(d.id);
  const shareUrl = `${publicOrigin(await headers())}/library/${encodeURIComponent(d.id)}`;
  const seen = seenPercent(d);
  const facts = basics(d);
  const fidelity = metrics(d);

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
          <div className="detail-actions">
            <ViewInRoom id={d.id} />
            {d.kind === "avatar" && (
              <ViewerLink query={`mode=chess&opponent=${encodeURIComponent(d.id)}`} className="btn secondary">
                Play chess with them
              </ViewerLink>
            )}
            <ShareButton title={d.name} url={shareUrl} />
          </div>

          <GuidePanel id={d.id} durationS={d.durationS} initial={guide} />

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

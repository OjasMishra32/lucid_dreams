import type { Metadata } from "next";
import Kiosk, { type KioskSlide } from "@/components/Kiosk";
import { listReady } from "@/lib/bridge/dreams";
import { intentOf } from "@/lib/bridge/experience";
import type { Dream } from "@/lib/dream";
import { displayName, mediaUrl } from "@/lib/present";
import { SHOWCASE_IDS, chessLabel, legendOf } from "@/lib/showcase";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Kiosk" };

/**
 * For the laptop on the demo table: the best dreams full screen, one every 8 seconds, with the person's name and the
 * one sentence. The showcase dreams lead, then the newest; test bundles only when there's nothing else.
 */
export default function KioskPage() {
  const withPreview = listReady().filter((d) => d.preview);
  const real = withPreview.filter((d) => !d.id.startsWith("synthetic") && !d.id.startsWith("test-"));
  const pool = real.length ? real : withPreview;
  const rank = (d: Dream) => {
    const i = SHOWCASE_IDS.indexOf(d.id);
    return i < 0 ? SHOWCASE_IDS.length : i;
  };
  const slides: KioskSlide[] = [...pool]
    .sort((a, b) => rank(a) - rank(b)) // stable: the rest stay newest first
    .map((d) => ({
      id: d.id,
      name: displayName(d),
      line: line(d),
      ...(legendOf(d.id) ? { note: chessLabel(legendOf(d.id)!) } : {}),
      preview: mediaUrl(d, d.preview)!,
      poster: mediaUrl(d, d.thumb),
    }));
  return <Kiosk slides={slides} />;
}

function line(d: Dream): string {
  const said = intentOf(d)?.replace(/[.!]+$/, "");
  if (said) return `“${said.charAt(0).toUpperCase()}${said.slice(1)}.”`;
  return d.kind === "avatar" ? "From a few photos, in your room." : "From one video. Walk all the way around them.";
}

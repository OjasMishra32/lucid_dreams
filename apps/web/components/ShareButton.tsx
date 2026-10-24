"use client";

import { useState } from "react";

/**
 * The share sheet where there is one; otherwise copy the link. On the LAN the bridge is plain http, where neither the
 * share sheet nor the clipboard API exists, so it falls back to the old copy command, and if even that fails it shows
 * the link to copy by hand. It never says "copied" unless something was.
 */
export default function ShareButton({ title, url }: { title: string; url: string }) {
  const [state, setState] = useState<"idle" | "copied" | "show">("idle");

  async function share() {
    if (navigator.share && window.isSecureContext) {
      try {
        await navigator.share({ title, url });
        return;
      } catch (e) {
        if ((e as DOMException)?.name === "AbortError") return; // they closed the sheet
      }
    }
    if (await copy(url)) {
      setState("copied");
      setTimeout(() => setState("idle"), 1800);
    } else {
      setState("show");
    }
  }

  return (
    <>
      <button className="btn secondary" onClick={share} aria-live="polite">
        {state === "copied" ? "Link copied" : "Share"}
      </button>
      {state === "show" && (
        <input className="input share-link" value={url} readOnly aria-label="Link to this dream" onFocus={(e) => e.currentTarget.select()} autoFocus />
      )}
    </>
  );
}

export async function copy(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // denied: try the old way
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

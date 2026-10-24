"use client";

import { useState } from "react";
import { copy } from "./ShareButton";

/**
 * "Open on Quest": the viewer's address on this Mac's Wi-Fi, big enough to read across a table and type by hand,
 * because the Quest browser can't scan a QR code. Host on one line, the dream on the next; the scheme is quiet.
 */
export default function QuestUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const [, scheme = "", host = url, path = ""] = /^(https?:\/\/)?([^/?#]+)(.*)$/.exec(url) ?? [];

  async function onCopy() {
    setCopied(await copy(url));
    setTimeout(() => setCopied(null), 1800);
  }

  return (
    <section className="quest" aria-labelledby="quest-title">
      <h2 id="quest-title">Open on Quest</h2>
      <p className="quest-how">In the Quest browser, type</p>
      <div className="quest-url">
        <code>
          <span className="quest-host">
            <span className="quest-scheme">{scheme}</span>
            {host}
          </span>
          <span>{path}</span>
        </code>
        <button className="btn secondary btn-sm" onClick={onCopy} aria-live="polite">
          {copied === true ? "Copied" : copied === false ? "Select it to copy" : "Copy"}
        </button>
      </div>
      <p className="note">Same Wi-Fi as this Mac. If the Quest warns about the certificate, choose Advanced, then Proceed.</p>
    </section>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import TrimPicker from "@/components/TrimPicker";
import type { JobKind } from "@/lib/dream";
import { WINDOW_S, formatBytes, inspect, mediaOf, nameFromFile, type Check, type Inspected } from "@/lib/clipCheck";
import { personChecks } from "@/lib/personCheck";

const ICONS: Record<Check["level"], React.ReactNode> = {
  ok: (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.4 10.4l2.4 2.4 4.8-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  warn: (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 5.8v5.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="10" cy="14" r="1" fill="currentColor" />
    </svg>
  ),
  bad: (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  wait: <span className="check-wait" aria-hidden="true"><span className="pulse" /></span>,
};

export default function MakeDream() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const preview = useRef<HTMLVideoElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<Inspected | null>(null);
  const [name, setName] = useState("");
  const [typed, setTyped] = useState(false); // a name the person typed survives choosing another file
  const [kind, setKind] = useState<JobKind>("replay");
  const [startS, setStartS] = useState(0);
  const [people, setPeople] = useState<Check[] | "looking" | null>(null); // null: the pose model couldn't run here
  const [consent, setConsent] = useState(false);
  const [over, setOver] = useState(false);
  const [sent, setSent] = useState<number | null>(null); // upload progress 0-1 while sending
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => void (info && URL.revokeObjectURL(info.url)), [info]);

  // a finite length only: browser-recorded WebM often reports Infinity until it's played through
  const lengthS = info?.durationS ?? NaN;
  const trimmable = !!info?.readable && info.media === "video" && Number.isFinite(lengthS) && lengthS > WINDOW_S + 0.3;

  // "One person, head to toe": checked on the photo, or across the chosen window of the clip (after it settles).
  useEffect(() => {
    if (!info?.readable) return setPeople(null);
    let alive = true;
    setPeople("looking");
    const timer = setTimeout(() => {
      personChecks(info.media, info.url, { startS, lengthS: Math.min(WINDOW_S, info.durationS ?? WINDOW_S) })
        .then((checks) => alive && setPeople(checks))
        .catch(() => alive && setPeople(null));
    }, info.media === "video" ? 400 : 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [info, startS]);

  // The preview plays just the chosen 5 seconds, on a loop, wrapping at frame accuracy (no flash of the clip's start).
  useEffect(() => {
    const v = preview.current;
    if (!v || !trimmable) return;
    const end = startS + WINDOW_S;
    const wrap = () => {
      if (v.ended || v.currentTime >= end - 0.03 || v.currentTime < startS - 0.1) {
        v.currentTime = startS;
        v.play().catch(() => {});
      }
    };
    v.currentTime = startS;
    v.play().catch(() => {});
    let handle = 0;
    const frames = typeof v.requestVideoFrameCallback === "function";
    const tick = () => {
      wrap();
      handle = frames ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    };
    tick();
    v.addEventListener("ended", wrap);
    return () => {
      if (frames) v.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
      v.removeEventListener("ended", wrap);
    };
  }, [startS, trimmable]);

  async function choose(f: File | undefined) {
    if (!f) return;
    setError(null);
    if (!mediaOf(f)) return setError("Use a video (MP4, MOV) or a photo (JPG, PNG).");
    const inspected = await inspect(f);
    setFile(f);
    setInfo(inspected);
    setStartS(0);
    setConsent(false);
    if (!typed) setName(nameFromFile(f));
    setKind(inspected.media === "photo" ? "avatar" : "replay");
  }

  function reset() {
    setFile(null);
    setInfo(null);
    setError(null);
    if (input.current) input.current.value = "";
  }

  function send() {
    if (!file || !info) return;
    setError(null);
    setSent(0);
    const body = new FormData();
    body.append("name", name.trim());
    body.append("kind", kind);
    if (trimmable) body.append("startS", startS.toFixed(2));
    body.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/jobs");
    xhr.upload.onprogress = (e) => e.lengthComputable && setSent(e.loaded / e.total);
    xhr.onload = () => {
      const reply = safeJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300 && reply?.id) {
        router.push(`/jobs/${encodeURIComponent(reply.id)}`);
      } else {
        setSent(null);
        setError(reply?.error ?? "The bridge didn't accept the upload. Try again.");
      }
    };
    xhr.onerror = () => {
      setSent(null);
      setError("Couldn't reach the bridge. Is it running on Ojasva's Mac?");
    };
    xhr.send(body);
  }

  if (!file || !info) {
    return (
      <>
        <div
          className={over ? "drop over" : "drop"}
          role="button"
          tabIndex={0}
          onClick={() => input.current?.click()}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            choose(e.dataTransfer.files[0]);
          }}
        >
          <div>
            <svg viewBox="0 0 44 44" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="6" y="9" width="32" height="26" rx="6" />
              <path d="M22 28V16M17 21l5-5 5 5" />
            </svg>
            <h2>Drop a video or a photo</h2>
            <p>or click to choose one</p>
          </div>
          <input ref={input} type="file" accept="video/*,image/*" hidden onChange={(e) => choose(e.target.files?.[0])} />
        </div>
        {error && <p className="form-error">{error}</p>}
        <ul className="rules">
          <li><b>One person</b>Head to toe in the frame, filling most of it.</li>
          <li><b>Camera still</b>On a tripod or propped up. No pans or zooms.</li>
          <li><b>4K portrait</b>At least 1080p, 9:16, five seconds or more. 60 fps if you can.</li>
          <li><b>Bright, even light</b>A plain background and a fast shutter, so nothing blurs.</li>
        </ul>
      </>
    );
  }

  const photo = info.media === "photo";
  const checks: Check[] = [
    ...info.checks,
    ...(people === "looking"
      ? [{ level: "wait" as const, title: "Looking for the person", detail: "Checking they're alone in frame, head to toe." }]
      : people ?? []),
  ];
  const blocked = checks.some((c) => c.level === "bad");
  const needsConsent = photo && !consent;
  const sending = sent !== null;

  return (
    <div className="compose">
      <div>
        {info.readable && (
          <div className="frame" style={{ aspectRatio: `${info.width} / ${info.height}` }}>
            {photo ? <img src={info.url} alt="" /> : <video ref={preview} src={info.url} autoPlay muted loop={!trimmable} playsInline />}
          </div>
        )}
        {trimmable && (
          <TrimPicker url={info.url} durationS={lengthS} windowS={WINDOW_S} startS={startS} onChange={setStartS} />
        )}
        <p className="muted" style={{ fontSize: 14, margin: "14px 0 0" }}>
          {file.name} · {formatBytes(file.size)}
        </p>
        {!sending && (
          <button className="swap" onClick={reset}>
            Choose another
          </button>
        )}
      </div>

      <div>
        <ul className="checks" aria-live="polite">
          {checks.map((c) => (
            <li key={c.title} className={c.level}>
              {ICONS[c.level]}
              <div>
                <b>{c.title}</b>
                <span>{c.detail}</span>
              </div>
            </li>
          ))}
        </ul>
        {!blocked && (
          <p className="muted" style={{ fontSize: 15, margin: "-16px 0 36px" }}>
            {`We can't check the rest from here: ${people === null ? "one person, head to toe, " : ""}${photo ? "bright, even light." : "camera still, bright even light."}`}
          </p>
        )}

        <label className="field">
          <span>Name</span>
          <input
            className="input"
            value={name}
            maxLength={80}
            placeholder="Grandpa's two-step"
            onChange={(e) => {
              setName(e.target.value);
              setTyped(e.target.value.trim() !== "");
            }}
            disabled={sending}
          />
        </label>

        <div className="field">
          <span>Make them a</span>
          <div className="choice">
            <button type="button" className={kind === "replay" ? "on" : ""} onClick={() => setKind("replay")} disabled={sending || photo}>
              <b>Replay</b>
              <span>{photo ? "Needs a video" : "Moves exactly like the clip"}</span>
            </button>
            <button type="button" className={kind === "avatar" ? "on" : ""} onClick={() => setKind("avatar")} disabled={sending || !photo}>
              <b>Avatar</b>
              <span>{photo ? "Can learn any move" : "Needs a photo"}</span>
            </button>
          </div>
        </div>

        {photo && (
          <label className="consent">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={sending} />
            <span>
              <b>I have permission to bring this person in.</b>
              They, or their family, said yes to being rebuilt in 3D.
            </span>
          </label>
        )}

        <div className="submit-row">
          <button className="btn" onClick={send} disabled={blocked || needsConsent || !name.trim() || sending}>
            {sending ? "Uploading" : "Make dream"}
          </button>
          {sending && (
            <>
              <div className="bar">
                <span style={{ width: `${Math.max(2, sent * 100)}%` }} />
              </div>
              <span className="muted num" style={{ fontSize: 14 }}>{Math.round(sent * 100)}%</span>
            </>
          )}
        </div>
        {blocked && <p className="form-error">Fix the red items above, then try again.</p>}
        {error && <p className="form-error">{error}</p>}
      </div>
    </div>
  );
}

function safeJson(text: string): { id?: string; error?: string } | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

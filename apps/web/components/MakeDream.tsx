"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import TrimPicker from "@/components/TrimPicker";
import WindowFinder from "@/components/WindowFinder";
import type { JobKind } from "@/lib/dream";
import { WINDOW_S, formatBytes, inspect, mediaOf, nameFromFile, type Check, type Inspected } from "@/lib/clipCheck";
import { personChecks } from "@/lib/personCheck";
import { MAX_PHOTOS, bodyScore, leftOut, lookAt, type PhotoLook } from "@/lib/photoSet";

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

// One sentence of what you want to do with them: the intent Gemini plans the experience from. A replay can teach or
// keep you company; only an avatar (from a photo) can sit across a chess board.
const SUGGESTIONS = {
  video: ["Teach me this", "Sit next to me and teach me this piece", "Just be with me"],
  photo: ["Just be with me", "Play chess with me"],
};

/** One photo in a set: the file, what the browser could read of it, and what the models saw (null: they couldn't run). */
type Shot = { key: string; file: File; info: Inspected; look: PhotoLook | null | "looking" };

/** Why a photo is left out, or null. "No face" is the models' word against yours: a tap uses it anyway (forced). */
const verdict = (s: Shot, forced: Set<string>) => {
  const why = s.look && s.look !== "looking" ? leftOut(s.look) : null;
  return why === "No face" && forced.has(s.key) ? null : why;
};

/** The body photo: the one tapped, else the best head-to-toe one; never one that's left out (unless they all are). */
function bodyOf(shots: Shot[], pick: string | null, forced: Set<string>): Shot | null {
  const usable = shots.filter((s) => !verdict(s, forced));
  const picked = usable.find((s) => s.key === pick);
  if (picked) return picked;
  const score = (s: Shot) => (s.look && s.look !== "looking" ? bodyScore(s.look) : s.info.readable ? 0 : -0.5);
  return usable.reduce<Shot | null>((best, s) => (!best || score(s) > score(best) ? s : best), null) ?? shots[0] ?? null;
}

export default function MakeDream() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const more = useRef<HTMLInputElement>(null);
  const compose = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLVideoElement>(null);
  const urls = useRef(new Set<string>()); // every preview URL made, revoked on reset and on the way out
  const nextKey = useRef(0);
  const [video, setVideo] = useState<{ file: File; info: Inspected } | null>(null);
  const [shots, setShots] = useState<Shot[]>([]); // a photo set: one person, the body photo and their face photos
  const [pick, setPick] = useState<string | null>(null);
  const [forced, setForced] = useState<Set<string>>(new Set()); // photos used although no face was found in them
  const [name, setName] = useState("");
  const [typed, setTyped] = useState(false); // a name the person typed survives choosing another file
  const [kind, setKind] = useState<JobKind>("replay");
  const [intent, setIntent] = useState("");
  const [startS, setStartS] = useState(0);
  const [people, setPeople] = useState<Check[] | "looking" | null>(null); // null: the pose model couldn't run here
  const [consent, setConsent] = useState(false);
  const [over, setOver] = useState(false);
  const [sent, setSent] = useState<number | null>(null); // upload progress 0-1 while sending
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  // keyboard: once a file is in, the drop zone is gone; carry focus to the form that replaced it
  const chosen = Boolean(video || shots.length);
  useEffect(() => {
    if (chosen) compose.current?.focus({ preventScroll: true });
  }, [chosen]);

  const photos = shots.length > 0;
  const body = photos ? bodyOf(shots, pick, forced) : null;
  const file = body?.file ?? video?.file ?? null;
  const info = body?.info ?? video?.info ?? null;
  const usable = shots.filter((s) => !verdict(s, forced));
  const looking = shots.some((s) => s.look === "looking");

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

  async function choose(list: ArrayLike<File> | null | undefined) {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    setError(null);
    const media = mediaOf(files[0]);
    if (!media) return setError("Use a video (MP4, MOV) or photos (JPG, PNG).");
    if (media === "photo") return addPhotos(files, true);
    const inspected = await inspect(files[0]);
    forget();
    urls.current.add(inspected.url);
    setVideo({ file: files[0], info: inspected });
    setStartS(0);
    setConsent(false);
    if (!typed) setName(nameFromFile(files[0]));
    setKind("replay");
  }

  /** Photos of one person, up to ten: each is checked as it arrives (one person, their face, head to toe or not). */
  async function addPhotos(files: File[], fresh: boolean) {
    const all = files.filter((f) => mediaOf(f) === "photo");
    const room = MAX_PHOTOS - (fresh ? 0 : shots.length);
    const take = all.slice(0, Math.max(room, 0));
    if (all.length > take.length) setError(`Up to ${MAX_PHOTOS} photos of one person, so ${all.length - take.length} ${all.length - take.length === 1 ? "wasn't" : "weren't"} added.`);
    else setError(null);
    if (!take.length) return;
    const before = fresh ? [...urls.current] : [];
    const added: Shot[] = [];
    for (const f of take) {
      const inspected = await inspect(f);
      urls.current.add(inspected.url);
      added.push({ key: String(nextKey.current++), file: f, info: inspected, look: inspected.readable ? "looking" : null });
    }
    if (fresh) {
      for (const u of before) {
        URL.revokeObjectURL(u); // only what was there before: the new photos' previews stay
        urls.current.delete(u);
      }
      setVideo(null);
      setPick(null);
      setForced(new Set());
      setStartS(0);
      setShots(added);
      if (!typed) setName(nameFromFile(take[0]));
    } else setShots((s) => [...s, ...added]);
    setConsent(false); // the tick covers the photos that were there when it was ticked
    setKind("avatar");
    for (const s of added) {
      if (s.look !== "looking") continue;
      lookAt(s.info.url)
        .catch(() => null)
        .then((look) => setShots((prev) => prev.map((p) => (p.key === s.key ? { ...p, look } : p))));
    }
  }

  function toggle(key: string) {
    setForced((f) => {
      const next = new Set(f);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  function remove(key: string) {
    const gone = shots.find((s) => s.key === key);
    if (!gone) return;
    if (shots.length === 1) return reset();
    URL.revokeObjectURL(gone.info.url);
    urls.current.delete(gone.info.url);
    setShots((s) => s.filter((p) => p.key !== key));
    if (pick === key) setPick(null);
  }

  function forget() {
    urls.current.forEach((u) => URL.revokeObjectURL(u));
    urls.current.clear();
  }

  function reset() {
    forget();
    setVideo(null);
    setShots([]);
    setPick(null);
    setForced(new Set());
    setError(null);
    if (input.current) input.current.value = "";
  }

  function send() {
    if (!file || !info) return;
    // the website in the cloud has no way to HiPerGator: say so before anything is uploaded
    if (process.env.NEXT_PUBLIC_LUCID_CLOUD) {
      setError("Making a new dream needs our HiPerGator connection, and it isn't on right now. Every scene above works without it.");
      return;
    }
    setError(null);
    setSent(0);
    const form = new FormData();
    form.append("name", name.trim());
    form.append("kind", kind);
    if (intent.trim()) form.append("intent", intent.trim());
    if (trimmable) form.append("startS", startS.toFixed(2));
    // a photo set: the body photo first, then every face photo (the bridge keeps those in faces/ beside it)
    for (const f of photos && body ? [body, ...usable.filter((s) => s !== body)].map((s) => s.file) : [file]) form.append("file", f);
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
    xhr.send(form);
  }

  if (!file || !info) {
    return (
      <>
        <div
          className={over ? "drop over" : "drop"}
          role="button"
          tabIndex={0}
          onClick={() => input.current?.click()}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault(); // Space would scroll the page
            input.current?.click();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            choose(e.dataTransfer.files);
          }}
        >
          <div>
            <svg viewBox="0 0 44 44" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="6" y="9" width="32" height="26" rx="6" />
              <path d="M22 28V16M17 21l5-5 5 5" />
            </svg>
            <h2>Drop a video, or photos of one person</h2>
            <p>or click to choose. For photos, add a couple of face close-ups.</p>
          </div>
          <input ref={input} type="file" accept="video/*,image/*" multiple hidden onChange={(e) => choose(e.target.files)} />
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
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
    ...(photos ? setChecks(shots, forced, usable.length, looking) : []),
  ];
  const blocked = checks.some((c) => c.level === "bad") || looking;
  const needsConsent = photo && !consent;
  const sending = sent !== null;

  return (
    <div className="compose" ref={compose} tabIndex={-1} aria-label="Your dream, ready to make">
      <div>
        {info.readable && (
          <div className="frame" style={{ aspectRatio: `${info.width} / ${info.height}` }}>
            {photo ? (
              <img src={info.url} alt={photos && shots.length > 1 ? "The photo that builds the body" : "Your photo"} />
            ) : (
              <video ref={preview} src={info.url} autoPlay muted loop={!trimmable} playsInline aria-label="Your clip: the five seconds we'll rebuild" />
            )}
          </div>
        )}
        {photos && (
          <div className="shots">
            <ul aria-label="Photos of this person">
              {shots.map((s, i) => {
                const out = verdict(s, forced);
                const isBody = s === body;
                const tag = s.look === "looking" ? "Checking" : out ?? (isBody ? "Body" : "Face");
                // a photo with no face found: a tap uses it anyway, and another tap leaves it out again
                const unconfirmed = s.look && s.look !== "looking" && leftOut(s.look) === "No face";
                const tap = () => (unconfirmed && (out || !isBody) ? toggle(s.key) : setPick(s.key));
                return (
                  <li key={s.key} className={out ? "out" : isBody ? "on" : undefined}>
                    <button
                      type="button"
                      className="shot"
                      onClick={tap}
                      disabled={sending || out === "Two people" || s.look === "looking"}
                      aria-pressed={isBody}
                      aria-label={`Photo ${i + 1}: ${tag}${out === "No face" ? ". Use it anyway" : !out && !isBody ? ". Build the body from this one" : ""}`}
                    >
                      <span className="shot-img">
                        {s.info.readable ? <img src={s.info.url} alt="" /> : <span className="shot-raw">{s.file.name.split(".").pop()?.toUpperCase()}</span>}
                      </span>
                      <span className="shot-tag">{tag}</span>
                    </button>
                    {!sending && (
                      <button type="button" className="shot-x" onClick={() => remove(s.key)} aria-label={`Remove photo ${i + 1}`}>
                        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3L3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                      </button>
                    )}
                  </li>
                );
              })}
              {shots.length < MAX_PHOTOS && !sending && (
                <li>
                  <button type="button" className="shot" onClick={() => more.current?.click()}>
                    <span className="shot-img shot-add">
                      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                    </span>
                    <span className="shot-tag">Add</span>
                  </button>
                </li>
              )}
            </ul>
            <input
              ref={more}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                addPhotos(Array.from(e.target.files ?? []), false);
                e.target.value = "";
              }}
            />
            <p className="shots-note">
              Up to {MAX_PHOTOS} photos of the same person. The head-to-toe one builds the body, the rest go to the face.
              Tap a photo to build the body from it instead.
            </p>
          </div>
        )}
        {trimmable && (
          <TrimPicker url={info.url} durationS={lengthS} windowS={WINDOW_S} startS={startS} onChange={setStartS} />
        )}
        {trimmable && lengthS >= 12 && <WindowFinder url={info.url} durationS={lengthS} startS={startS} onPick={setStartS} disabled={sending} />}
        <p className="muted" style={{ fontSize: 14, margin: "14px 0 0" }}>
          {photos && shots.length > 1
            ? `${shots.length} photos · ${formatBytes(shots.reduce((n, s) => n + s.file.size, 0))}`
            : `${file.name} · ${formatBytes(file.size)}`}
        </p>
        {!sending && (
          <button className="swap" onClick={reset}>
            {photos && shots.length > 1 ? "Start over" : "Choose another"}
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

        <div className="field">
          <label htmlFor="intent">What do you want to do with them?</label>
          <input
            id="intent"
            className="input"
            value={intent}
            maxLength={200}
            placeholder={photo ? "I just want to sit with her" : "Teach me this strum"}
            onChange={(e) => setIntent(e.target.value)}
            disabled={sending}
          />
          <div className="suggestions">
            {SUGGESTIONS[photo ? "photo" : "video"].map((s) => (
              <button key={s} type="button" className={intent === s ? "on" : ""} onClick={() => setIntent(s)} disabled={sending}>
                {s}
              </button>
            ))}
          </div>
        </div>

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
              They, or their family, said yes to being rebuilt in 3D{shots.length > 1 ? ", from every photo here" : ""}.
            </span>
          </label>
        )}

        <div className="submit-row">
          <button className="btn" onClick={send} disabled={blocked || needsConsent || !name.trim() || sending}>
            {sending ? "Uploading" : "Make dream"}
          </button>
          {sending && (
            <>
              <div className="bar" role="progressbar" aria-label="Uploading" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(sent * 100)}>
                <span style={{ width: `${Math.max(2, sent * 100)}%` }} />
              </div>
              <span className="muted num" style={{ fontSize: 14 }}>{Math.round(sent * 100)}%</span>
            </>
          )}
        </div>
        {blocked && !looking && <p className="form-error">Fix the red items above, then try again.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}

/** What the set as a whole needs: photos left out and why, and whether there's anything for the face model. */
function setChecks(shots: Shot[], forced: Set<string>, usable: number, looking: boolean): Check[] {
  const out: Check[] = [];
  if (looking) out.push({ level: "wait", title: "Checking each photo", detail: "One person in every one, and their face." });
  const count = (why: string) => shots.filter((s) => verdict(s, forced) === why).length;
  const photos = (n: number) => `${n} photo${n === 1 ? "" : "s"}`;
  const two = count("Two people");
  const noFace = count("No face");
  const anyway = shots.filter((s) => forced.has(s.key) && s.look && s.look !== "looking" && leftOut(s.look) === "No face").length;
  if (two) out.push({ level: "warn", title: `${photos(two)} with two people, left out`, detail: "Every photo has to be just them. Crop it, or use another." });
  if (noFace) {
    out.push({ level: "warn", title: `No face found in ${photos(noFace)}, left out`, detail: "Use one where they look toward the camera, or tap it to use it anyway if it's really just them." });
  }
  if (anyway) out.push({ level: "warn", title: `${photos(anyway)} used without a face found`, detail: "We couldn't confirm their face there. Make sure it's them, alone." });
  if (looking) return out;
  if (!usable) {
    out.push({ level: "bad", title: "None of these photos can be used", detail: "Add a photo of just them, head to toe, with their face showing." });
  } else if (usable > 1) {
    out.push({ level: "ok", title: `${photos(usable - 1)} for the face`, detail: "Each one goes to the face model, and the closest likeness is the one you get." });
  } else if (shots.length < MAX_PHOTOS) {
    out.push({ level: "warn", title: "Add a close-up of their face", detail: "A second photo, looking at the camera, makes the face far more like them." });
  }
  return out;
}

function safeJson(text: string): { id?: string; error?: string } | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

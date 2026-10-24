"use client";

import { useEffect, useRef, useState } from "react";
import { clock, type Attempt, type Attempts } from "@/lib/attempt";
import { formatDate } from "@/lib/format";
import { ViewerLink } from "./ViewInRoom";

const SPEEDS: [number, string][] = [[1, "1×"], [0.5, "½×"], [0.25, "¼×"]];
const COUNT_S = 5; // time to step back into the frame
const LIMIT_S = 15; // the bridge keeps 20 s; the move is a few
// MP4 first: the Mac re-encodes it (and strips location); WebM only where the browser can't record anything else
const TYPES = ["video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

type Step = { start: number; end: number; title: string; tip?: string };
type Phase = "idle" | "camera" | "countdown" | "recording" | "review" | "sending";
type Local = { url: string; blob: Blob; name: string; durationS: number | null; playable: boolean };

/**
 * Film your try at the lesson (the laptop or phone camera where the page may use it; the phone's own camera app
 * otherwise), send it to the bridge, and get Gemini's notes beside both videos, each one a tap away on both.
 */
export default function WatchMeTry({ id, steps, clockS, initial }: { id: string; steps: Step[]; clockS: number; initial: Attempts }) {
  const base = `/api/dreams/${encodeURIComponent(id)}/attempts`;
  const [data, setData] = useState<Attempts>(initial);
  const [selected, setSelected] = useState<string | null>(initial.attempts[0]?.id ?? null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [local, setLocal] = useState<Local | null>(null);
  const [sentFor, setSentFor] = useState<string | null>(null); // the try `local` became, until its own video is ready
  const [count, setCount] = useState(COUNT_S);
  const [elapsed, setElapsed] = useState(0);
  const [sent, setSent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<boolean | null>(null); // the camera API works on this page (secure context)
  const [touch, setTouch] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [active, setActive] = useState(-1);
  const [lessonNow, setLessonNow] = useState(0);
  const [tryNow, setTryNow] = useState(0);

  const lessonRef = useRef<HTMLVideoElement>(null);
  const tryRef = useRef<HTMLVideoElement>(null);
  const liveRef = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const timers = useRef<ReturnType<typeof setInterval>[]>([]);

  useEffect(() => {
    setLive(window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined");
    setTouch(window.matchMedia("(pointer: coarse)").matches);
    return () => {
      stopCamera();
      timers.current.forEach(clearInterval);
    };
  }, []);

  // Let go of a recording's blob URL once it's replaced (not when only its length or playability is filled in).
  const shown = useRef<string | null>(null);
  useEffect(() => {
    const next = local?.url ?? null;
    if (shown.current && shown.current !== next) URL.revokeObjectURL(shown.current);
    shown.current = next;
  }, [local]);
  useEffect(() => () => void (shown.current && URL.revokeObjectURL(shown.current)), []);

  // While the lesson clip is being cut or a try is being watched, check back every few seconds.
  const waiting = data.lesson.state === "working" || data.attempts.some((a) => a.state === "working");
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(base, { cache: "no-store" });
        if (!r.ok) return setData({ ...data });
        const fresh: Attempts = await r.json();
        // a try sent while this answer was on its way isn't in it yet: keep it
        setData((d) => ({
          ...fresh,
          attempts: [
            ...d.attempts.filter((a) => a.state === "working" && !fresh.attempts.some((f) => f.id === a.id) && Date.now() - Date.parse(a.createdAt) < 60_000),
            ...fresh.attempts,
          ],
        }));
      } catch {
        setData({ ...data }); // a hiccup: ask again
      }
    }, 3000);
    return () => clearTimeout(t);
  }, [waiting, data, base]);

  useEffect(() => {
    for (const v of [lessonRef.current, tryRef.current]) if (v) v.playbackRate = speed;
  }, [speed, phase, selected, data.lesson.state]);

  // The camera shows in the try's frame (mirrored, like a mirror) from the moment it's on until the recording stops.
  useEffect(() => {
    const v = liveRef.current;
    if (!v || !stream.current || v.srcObject === stream.current) return;
    v.srcObject = stream.current;
    v.play().catch(() => {});
  }, [phase]);

  const attempt = data.attempts.find((a) => a.id === selected) ?? null;
  const lesson = data.lesson.state === "ready" ? data.lesson : null;
  const scale = lesson?.scale || 1;
  const filming = phase === "camera" || phase === "countdown" || phase === "recording";
  const trySrc =
    phase === "review" || phase === "sending" ? local?.url
    : attempt?.video ?? (local && sentFor === attempt?.id ? local.url : null);
  const lessonT = lesson?.orbit && clockS > 0 ? (lessonNow / scale) % clockS : lessonNow / scale; // an orbit render loops the move
  const step = steps.find((s) => lessonT >= s.start - 0.02 && lessonT < s.end);

  // ---------- the camera ----------

  async function startCamera() {
    setError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", aspectRatio: { ideal: 9 / 16 }, height: { ideal: 1280 } },
        audio: false,
      });
      stream.current = s;
      setPhase("camera");
    } catch (e) {
      const name = (e as DOMException)?.name;
      setError(
        name === "NotAllowedError" ? "The camera is blocked for this page. Allow it in the browser, or choose a video of your try."
        : name === "NotFoundError" || name === "OverconstrainedError" ? "There's no camera here. Choose a video of your try instead."
        : "The camera didn't start. Choose a video of your try instead.",
      );
      setLive(false);
    }
  }

  function stopCamera() {
    stream.current?.getTracks().forEach((t) => t.stop()); // the camera light goes off
    stream.current = null;
  }

  function clearTimers() {
    timers.current.forEach(clearInterval);
    timers.current = [];
  }

  function cancel() {
    clearTimers();
    if (recorder.current?.state === "recording") {
      recorder.current.onstop = null;
      recorder.current.stop();
    }
    stopCamera();
    setPhase("idle");
  }

  function countdown() {
    setCount(COUNT_S);
    setPhase("countdown");
    let n = COUNT_S;
    const t = setInterval(() => {
      n -= 1;
      setCount(n);
      if (n <= 0) {
        clearTimers();
        record();
      }
    }, 1000);
    timers.current.push(t);
  }

  function record() {
    const s = stream.current;
    if (!s) return setPhase("idle");
    const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(s, type ? { mimeType: type, videoBitsPerSecond: 8_000_000 } : undefined);
    const chunks: Blob[] = [];
    const began = performance.now();
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      clearTimers();
      stopCamera();
      const mime = (rec.mimeType || type || "video/webm").split(";")[0];
      const blob = new Blob(chunks, { type: mime });
      const durationS = Math.round(((performance.now() - began) / 1000) * 10) / 10;
      setLocal({ url: URL.createObjectURL(blob), blob, name: `try.${mime.includes("mp4") ? "mp4" : "webm"}`, durationS, playable: true });
      setPhase("review");
    };
    recorder.current = rec;
    rec.start(250);
    setElapsed(0);
    setPhase("recording");
    // the lesson plays alongside, from the top, so you can follow it
    const v = lessonRef.current;
    if (v) {
      v.currentTime = 0;
      v.play().catch(() => {});
    }
    const t = setInterval(() => {
      const s = (performance.now() - began) / 1000;
      setElapsed(s);
      if (s >= LIMIT_S && rec.state === "recording") rec.stop();
    }, 200);
    timers.current.push(t);
  }

  function stopRecording() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  function picked(f: File | undefined) {
    if (!f) return;
    setError(null);
    if (!f.type.startsWith("video/") && !/\.(mp4|mov|m4v|webm|3gp)$/i.test(f.name)) return setError("Choose a video of your try.");
    setLocal({ url: URL.createObjectURL(f), blob: f, name: f.name || "try.mp4", durationS: null, playable: true });
    setPhase("review");
  }

  // ---------- sending ----------

  function send() {
    if (!local) return;
    setError(null);
    setSent(0);
    setPhase("sending");
    const body = new FormData();
    body.append("file", local.blob, local.name);
    if (local.durationS) body.append("durationS", String(local.durationS));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", base);
    xhr.upload.onprogress = (e) => e.lengthComputable && setSent(e.loaded / e.total);
    xhr.onload = () => {
      let reply: (Attempt & { error?: string }) | null = null;
      try {
        reply = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status === 202 && reply?.id) {
        setData((d) => ({ ...d, attempts: [reply!, ...d.attempts.filter((a) => a.id !== reply!.id)] }));
        setSelected(reply.id);
        setSentFor(reply.id);
        setActive(-1);
        setPhase("idle");
      } else {
        setError(reply?.error ?? "The Mac didn't take the video. Try again.");
        setPhase("review");
      }
    };
    xhr.onerror = () => {
      setError("The upload was interrupted. Try again.");
      setPhase("review");
    };
    xhr.send(body);
  }

  async function again(a: Attempt) {
    setError(null);
    const r = await fetch(`${base}/${encodeURIComponent(a.id)}`, { method: "POST" }).catch(() => null);
    const reply = r ? await r.json().catch(() => null) : null;
    if (r?.ok && reply?.id) setData((d) => ({ ...d, attempts: d.attempts.map((x) => (x.id === a.id ? reply : x)) }));
    else setError(reply?.error ?? "The Mac didn't answer. Try again.");
  }

  async function remove(a: Attempt) {
    if (!window.confirm("Delete this try and its notes from this Mac?")) return;
    const r = await fetch(`${base}/${encodeURIComponent(a.id)}`, { method: "DELETE" }).catch(() => null);
    if (r?.status === 204) {
      const rest = data.attempts.filter((x) => x.id !== a.id);
      setData({ ...data, attempts: rest });
      setSelected(rest[0]?.id ?? null);
      setActive(-1);
    } else setError((r && (await r.json().catch(() => null))?.error) ?? "The Mac didn't delete it. Try again.");
  }

  // ---------- playback ----------

  function playBoth() {
    const vs = [lessonRef.current, tryRef.current].filter((v): v is HTMLVideoElement => !!v && !!v.currentSrc);
    if (vs.some((v) => !v.paused)) return vs.forEach((v) => v.pause());
    vs.forEach((v) => {
      v.playbackRate = speed;
      v.play().catch(() => {});
    });
  }

  function seek(i: number) {
    const n = attempt?.notes?.[i];
    if (!n) return;
    setActive(i);
    const pairs: [HTMLVideoElement | null, number][] = [[tryRef.current, n.attemptS], [lessonRef.current, n.teacherS * scale]];
    for (const [v, t] of pairs) {
      if (!v) continue;
      v.currentTime = Math.min(t, Number.isFinite(v.duration) ? Math.max(v.duration - 0.05, 0) : t);
      v.playbackRate = speed;
      v.play().catch(() => {});
    }
    // on a phone the videos sit above the notes: bring them into view
    const box = tryRef.current?.getBoundingClientRect();
    if (box && box.bottom < 60) tryRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const onPlayState = () => setPlaying([lessonRef.current, tryRef.current].some((v) => v && !v.paused && !v.ended));

  const canFilm = data.lesson.state !== "none" && live !== null; // live is known after the first paint
  const notes = attempt?.state === "ready" ? (attempt.notes ?? []) : [];

  return (
    <div className="try-grid">
      <div className="try-stage">
        <div className={`try-pair${filming ? " filming" : ""}`}>
          <figure className="try-pane">
            <div className="try-video">
              {lesson ? (
                <video
                  ref={lessonRef}
                  src={`${lesson.src}#t=0.001`}
                  playsInline
                  muted
                  preload="auto"
                  onPlay={onPlayState}
                  onPause={onPlayState}
                  onEnded={onPlayState}
                  onTimeUpdate={(e) => setLessonNow(e.currentTarget.currentTime)}
                  aria-label="The lesson"
                />
              ) : (
                <div className="try-empty">
                  {data.lesson.state === "working" ? <span className="pulse" /> : null}
                  <span>{data.lesson.state === "working" ? "Cutting the lesson clip on this Mac" : "There's no clip of this lesson on this Mac."}</span>
                </div>
              )}
            </div>
            <figcaption className="try-cap">
              <b>The lesson</b>
              <span>{lesson && step ? step.title : lesson?.orbit ? "In 3D" :" "}</span>
            </figcaption>
          </figure>

          <figure className="try-pane">
            <div className="try-video">
              {filming ? (
                <>
                  <video ref={liveRef} className="mirror" playsInline muted autoPlay aria-label="Your camera" />
                  {phase === "countdown" && (
                    <div className="try-count" aria-live="assertive">
                      <b className="num">{count}</b>
                      <span>Step back until all of you is in the frame</span>
                    </div>
                  )}
                  {phase === "recording" && (
                    <p className="try-rec num" aria-live="off">
                      <i aria-hidden="true" />
                      {clock(elapsed)} / {clock(LIMIT_S)}
                    </p>
                  )}
                </>
              ) : trySrc && (local?.playable ?? true) ? (
                <video
                  ref={tryRef}
                  key={trySrc}
                  src={trySrc.startsWith("blob:") ? trySrc : `${trySrc}#t=0.001`}
                  playsInline
                  muted
                  preload="auto"
                  onPlay={onPlayState}
                  onPause={onPlayState}
                  onEnded={onPlayState}
                  onTimeUpdate={(e) => setTryNow(e.currentTarget.currentTime)}
                  onLoadedMetadata={(e) => {
                    const d = e.currentTarget.duration;
                    if (phase === "review" && local && !local.durationS && Number.isFinite(d)) setLocal({ ...local, durationS: Math.round(d * 10) / 10 });
                  }}
                  onError={() => phase === "review" && local && setLocal({ ...local, playable: false })}
                  aria-label="Your try"
                />
              ) : (
                <div className="try-empty">
                  <svg viewBox="0 0 40 40" aria-hidden="true">
                    <rect x="4" y="11" width="23" height="18" rx="4" fill="none" stroke="currentColor" strokeWidth="1.6" />
                    <path d="M27 17.5l8-4.5v14l-8-4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                  </svg>
                  <span>{phase === "review" ? "This browser can't play it, but the Mac can read it." : "Your try appears here"}</span>
                </div>
              )}
            </div>
            <figcaption className="try-cap">
              <b>Your try</b>
              <span className="num">{attempt?.video || phase === "review" ? clock(tryNow) : " "}</span>
            </figcaption>
          </figure>
        </div>

        <div className="try-bar">
        {!filming && phase !== "review" && phase !== "sending" && lesson && (
          <div className="try-controls">
            <button className="btn secondary btn-play" onClick={playBoth} aria-pressed={playing}>
              {playing ? "Pause" : trySrc ? "Play both" : "Play the lesson"}
            </button>
            <div className="segmented" role="group" aria-label="Playback speed">
              {SPEEDS.map(([v, label]) => (
                <button key={v} className={speed === v ? "on" : ""} aria-pressed={speed === v} onClick={() => setSpeed(v)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="try-actions">
          {phase === "idle" && canFilm && (
            <>
              {live ? (
                <button className="btn" onClick={startCamera}>{attempt ? "Film another try" : "Film my try"}</button>
              ) : (
                <label className="btn">
                  {!touch ? "Choose a video of your try" : attempt ? "Film another try" : "Film my try"}
                  <input type="file" accept="video/*" capture="user" className="sr-only" onChange={(e) => picked(e.target.files?.[0])} />
                </label>
              )}
              {live && (
                <label className="more try-pick">
                  Choose a video
                  <input type="file" accept="video/*" className="sr-only" onChange={(e) => picked(e.target.files?.[0])} />
                </label>
              )}
            </>
          )}
          {phase === "camera" && (
            <>
              <button className="btn" onClick={countdown}>Start</button>
              <button className="btn secondary" onClick={cancel}>Cancel</button>
            </>
          )}
          {phase === "countdown" && <button className="btn secondary" onClick={cancel}>Cancel</button>}
          {phase === "recording" && <button className="btn" onClick={stopRecording}>Stop</button>}
          {phase === "review" && (
            <>
              <button className="btn" onClick={send}>{data.gemini ? "Get my notes" : "Keep this try"}</button>
              <button
                className="btn secondary"
                onClick={() => {
                  setLocal(null);
                  setPhase("idle");
                }}
              >
                {live ? "Film again" : "Choose another"}
              </button>
            </>
          )}
          {phase === "sending" && (
            <div className="try-sending">
              <div className="bar" role="progressbar" aria-label="Sending your try" aria-valuenow={Math.round(sent * 100)} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${Math.max(4, sent * 100)}%` }} />
              </div>
              <span className="num">Sending to the Mac · {Math.round(sent * 100)}%</span>
            </div>
          )}
        </div>
        </div>
        {phase === "camera" && <p className="try-hint">Prop up your phone or laptop, press Start, and step back: you get {COUNT_S} seconds, then up to {LIMIT_S} seconds of you. The lesson plays alongside.</p>}
        {phase === "idle" && live === false && !touch && canFilm && (
          <p className="try-hint">The camera only works here on the Mac itself or over https. On your phone, the same button opens its camera.</p>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>

      <aside className="try-notes">
        <div aria-live="polite">
        {!attempt && (
          <>
            <h2>How it works</h2>
            <ol className="try-how">
              <li><span><b>Film your try.</b> All of you in the frame, up to {LIMIT_S} seconds.</span></li>
              <li><span><b>Gemini watches it next to the lesson.</b> It notes each moment that&apos;s off, and the fix.</span></li>
              <li><span><b>Your main fix joins the lesson,</b> so you can practise it in your room.</span></li>
            </ol>
            {data.lesson.state === "none" && <p className="try-state-note">There&apos;s no clip of this lesson on this Mac to compare with.</p>}
          </>
        )}

        {attempt?.state === "working" && (
          <div className="try-state">
            <span className="pulse" />
            <p>{attempt.stage === "preparing" ? "Getting your try ready on this Mac." : "Gemini is watching your try next to the lesson."}</p>
          </div>
        )}

        {attempt?.state === "failed" && (
          <>
            <h2>No notes this time</h2>
            <p className="try-state-note">{attempt.message ?? "Something went wrong."}</p>
            {attempt.video && <button className="btn secondary btn-sm try-again" onClick={() => again(attempt)}>Ask again</button>}
          </>
        )}

        {attempt?.state === "off" && (
          <>
            <h2>Side by side</h2>
            <p className="try-state-note">Notes need Gemini, which is off on this Mac. You can still compare your try with the lesson here.</p>
            {data.gemini && <button className="btn secondary btn-sm try-again" onClick={() => again(attempt)}>Get notes now</button>}
          </>
        )}

        {attempt?.state === "ready" && notes.length > 0 && (
          <>
            <h2>What to fix</h2>
            <ol className="try-list">
              {notes.map((n, i) => (
                <li key={i} className={i === 0 ? "try-first" : undefined}>
                  <button className={i === active ? "on" : ""} onClick={() => seek(i)} aria-current={i === active ? "true" : undefined}>
                    <span className="try-t num">{clock(n.attemptS)}</span>
                    <span>
                      {i === 0 && <span className="try-kicker">Main fix</span>}
                      <b>{n.note}</b>
                      <small className="num">Lesson at {n.teacherS.toFixed(1)} s</small>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            {attempt.good && <p className="try-good"><b>Already there.</b> {attempt.good}</p>}
            {attempt.added && (
              <div className="try-added">
                Your main fix is now the lesson&apos;s last step, &ldquo;Your fix&rdquo;, slowed down so you can copy it.
                <ViewerLink query={`dream=${encodeURIComponent(id)}`} className="more">Practise it in your room</ViewerLink>
              </div>
            )}
          </>
        )}

        {attempt?.state === "ready" && notes.length === 0 && (
          <>
            <h2>{attempt.unclear ? "Gemini couldn't compare this try" : "Close to the lesson"}</h2>
            <p className="try-state-note">{attempt.unclear ?? attempt.good ?? "Nothing stood out to fix."}</p>
          </>
        )}

        </div>

        {data.attempts.length > 1 && (
          <div className="try-earlier">
            <h3>Your tries</h3>
            <ul>
              {data.attempts.map((a) => (
                <li key={a.id}>
                  <button
                    className={a.id === selected ? "on" : ""}
                    aria-current={a.id === selected ? "true" : undefined}
                    onClick={() => {
                      setSelected(a.id);
                      setActive(-1);
                      setTryNow(0);
                    }}
                  >
                    <span className="num">{formatDate(a.createdAt)}</span>
                    <span>{summary(a)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="try-private">
          Film only yourself. Your try stays on this Mac; Gemini sees it only to write the notes, and it&apos;s deleted from
          Google right after.
          {attempt && attempt.state !== "working" && (
            <>
              {" "}
              <button className="try-delete" onClick={() => remove(attempt)}>Delete this try</button>
            </>
          )}
        </p>
      </aside>
    </div>
  );
}

function summary(a: Attempt): string {
  if (a.state === "working") return "Being watched";
  if (a.state === "failed") return "No notes";
  if (a.state === "off") return "Side by side";
  return a.notes?.[0]?.note ?? (a.unclear ? "Couldn't compare" : "Close to the lesson");
}

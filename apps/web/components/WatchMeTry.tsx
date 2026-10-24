"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Feedback, FeedbackNote } from "@/lib/dream";

type Phase = "idle" | "camera" | "countdown" | "recording" | "review" | "sending" | "done";

const MAX_S = 30; // the bridge refuses longer
const canRecord = () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";

/** The best container this browser can record: MP4 on Safari, WebM elsewhere. */
function recorderType(): string | undefined {
  return ["video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
}

function clock(s: number): string {
  const n = Math.max(0, Math.floor(s));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}

/**
 * "Watch me try" (team/raami.md, MORE 2): record your attempt with the camera, Gemini compares it with the teacher and
 * returns notes with times. Attempt and teacher sit side by side; tap a note and both videos jump to it. The video goes
 * to the bridge only when you press Get notes, is deleted there and at Gemini once the answer is in, and only the notes
 * stay (they're added to the plan as `feedback`). `span` maps the plan's clock onto the preview video (a mock stand-in's
 * is shorter than the clip).
 */
export default function WatchMeTry({
  id,
  teacherSrc,
  clockS,
  span,
  initial,
}: {
  id: string;
  teacherSrc: string | null;
  clockS: number;
  span: (v: HTMLVideoElement, clockS: number) => number;
  initial: Feedback | null;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [feedback, setFeedback] = useState<Feedback | null>(initial);
  const [error, setError] = useState("");
  const [count, setCount] = useState(3);
  const [elapsed, setElapsed] = useState(0);
  const [shot, setShot] = useState<{ url: string; blob: Blob; durationS: number } | null>(null);
  const [active, setActive] = useState(-1);
  const [secure, setSecure] = useState(true);

  const live = useRef<HTMLVideoElement>(null);
  const mine = useRef<HTMLVideoElement>(null);
  const teacher = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const abort = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const maxS = Math.min(MAX_S, Math.max(8, Math.ceil(clockS * 2.5)));

  useEffect(() => setSecure(canRecord()), []);

  const stopCamera = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);
  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (ticker.current) clearInterval(ticker.current);
    ticker.current = null;
  }, []);
  // leaving the page: the camera light goes off, and nothing is sent
  useEffect(() => () => {
    clearTimers();
    stopCamera();
    abort.current?.abort();
    if (recorder.current?.state === "recording") recorder.current.onstop = null;
  }, [clearTimers, stopCamera]);
  useEffect(() => () => void (shot && URL.revokeObjectURL(shot.url)), [shot]);

  useEffect(() => {
    if (live.current && stream.current && (phase === "camera" || phase === "countdown" || phase === "recording")) {
      live.current.srcObject = stream.current;
      live.current.play().catch(() => {});
    }
  }, [phase]);

  async function openCamera() {
    setError("");
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false, // the move is all Gemini needs: no microphone, so no sound is ever recorded
      });
      setPhase("camera");
    } catch (e) {
      const denied = (e as DOMException)?.name === "NotAllowedError";
      setError(denied ? "The camera is blocked. Allow it in your browser's site settings, then try again." : "No camera was found on this device.");
    }
  }

  function startCountdown() {
    setPhase("countdown");
    setCount(3);
    [1, 2].forEach((i) => timers.current.push(setTimeout(() => setCount(3 - i), i * 1000)));
    timers.current.push(setTimeout(record, 3000));
  }

  function record() {
    const s = stream.current;
    if (!s) return;
    chunks.current = [];
    const type = recorderType();
    const rec = new MediaRecorder(s, { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: 2_000_000 });
    recorder.current = rec;
    const began = Date.now();
    rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    rec.onstop = () => {
      clearTimers();
      stopCamera();
      const blob = new Blob(chunks.current, { type: rec.mimeType || type || "video/webm" });
      setShot({ url: URL.createObjectURL(blob), blob, durationS: Math.min((Date.now() - began) / 1000, MAX_S) });
      setPhase("review");
    };
    rec.start(250);
    setPhase("recording");
    setElapsed(0);
    ticker.current = setInterval(() => setElapsed((Date.now() - began) / 1000), 250);
    timers.current.push(setTimeout(stop, maxS * 1000));
  }

  function stop() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  function discard() {
    clearTimers();
    stopCamera();
    setShot(null);
    setError("");
    setPhase("idle");
  }

  /** A phone's own camera app, for a browser that won't open the camera (a page that isn't https). */
  function fromFile(file: File | undefined) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      if (!Number.isFinite(v.duration) || v.duration < 1) return fail(url, "That video is too short to judge.");
      if (v.duration > MAX_S) return fail(url, `Keep it to ${MAX_S} seconds: just the move.`);
      setShot({ url, blob: file, durationS: v.duration });
      setError("");
      setPhase("review");
    };
    v.onerror = () => fail(url, "This browser can't read that video. Record it again.");
    v.src = url;
    function fail(u: string, message: string) {
      URL.revokeObjectURL(u);
      setError(message);
    }
  }

  async function send() {
    if (!shot) return;
    setError("");
    setPhase("sending");
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const body = new FormData();
      body.append("durationS", shot.durationS.toFixed(2));
      body.append("attempt", shot.blob, "attempt");
      const r = await fetch(`/api/dreams/${encodeURIComponent(id)}/feedback`, { method: "POST", body, signal: ctl.signal });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.state !== "ready") throw new Error(j.error || "Gemini couldn't check that attempt. Try again.");
      setFeedback(j.feedback as Feedback);
      setActive(-1);
      setPhase("done");
      setTimeout(() => heading.current?.focus(), 50);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError((e as Error).message || "Gemini couldn't check that attempt. Try again.");
      setPhase("review");
    } finally {
      abort.current = null;
    }
  }

  function playBoth() {
    for (const v of [mine.current, teacher.current]) if (v) v.currentTime = 0;
    mine.current?.play().catch(() => {});
    teacher.current?.play().catch(() => {});
  }
  function pauseBoth() {
    mine.current?.pause();
    teacher.current?.pause();
  }
  /** Both videos to the moment a note is about. */
  function seek(i: number, n: FeedbackNote) {
    pauseBoth();
    setActive(i);
    if (mine.current && shot) mine.current.currentTime = n.attemptT;
    const t = teacher.current;
    if (t && n.teacherT != null) t.currentTime = Math.min(n.teacherT * span(t, clockS), Math.max(0, (t.duration || n.teacherT) - 0.05));
    const el = (mine.current ?? t)?.closest(".try-pair");
    if (el) {
      const r = el.getBoundingClientRect();
      if (Math.min(r.bottom, innerHeight) - Math.max(r.top, 48) < r.height / 2) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
  function follow() {
    const t = mine.current?.currentTime ?? 0;
    const notes = feedback?.notes ?? [];
    let i = -1;
    notes.forEach((n, k) => n.attemptT <= t + 0.05 && (i = k));
    setActive(i);
  }

  const showVideos = phase === "done" && shot;
  const notes = feedback?.notes ?? [];

  return (
    <section className="try" aria-labelledby="try-title">
      <h2 id="try-title" ref={heading} tabIndex={-1}>Watch me try</h2>

      {(phase === "camera" || phase === "countdown" || phase === "recording") && (
        <>
          <div className="try-frame try-live">
            <video ref={live} muted playsInline aria-label="Your camera, mirrored" />
            {phase === "countdown" && <div className="try-count num" aria-hidden="true">{count}</div>}
          </div>
          <p className="try-status" role="status" aria-live="polite">
            {phase === "camera" && "Step back until Gemini can see all of you, head to toe."}
            {phase === "countdown" && `Starting in ${count}`}
            {phase === "recording" && (
              <>
                <span className="rec-dot" aria-hidden="true" /> Recording <span className="num">{clock(elapsed)} / {clock(maxS)}</span>
              </>
            )}
          </p>
          <div className="try-actions">
            {phase === "camera" && <button className="btn" onClick={startCountdown}>Start in 3 seconds</button>}
            {phase === "recording" && <button className="btn" onClick={stop}>Stop</button>}
            {phase !== "recording" && <button className="btn secondary" onClick={discard}>Cancel</button>}
          </div>
        </>
      )}

      {(phase === "review" || phase === "sending") && shot && (
        <>
          <div className="try-frame">
            <video src={shot.url} controls playsInline aria-label="Your attempt, to check before sending" />
          </div>
          <div className="try-actions">
            <button className="btn" onClick={send} disabled={phase === "sending"}>{phase === "sending" ? "Checking" : "Get notes from Gemini"}</button>
            <button className="btn secondary" onClick={discard} disabled={phase === "sending"}>Record again</button>
          </div>
          {phase === "sending" ? (
            <div className="plan-working" role="status" aria-live="polite">
              <span className="pulse" />
              <p>Gemini is comparing you with the teacher. This takes up to a minute.</p>
            </div>
          ) : (
            <p className="note">Pressing Get notes sends this video to Gemini once. It&apos;s deleted there and on this Mac as soon as the answer is in; only the notes are kept.</p>
          )}
        </>
      )}

      {error && <p className="try-error" role="alert">{error}</p>}

      {(phase === "idle" || phase === "done") && feedback && (
        <div className="try-result">
          {showVideos && (
            <>
              <div className="try-pair">
                <figure>
                  <div className="try-frame"><video ref={mine} src={shot.url} playsInline muted onTimeUpdate={follow} aria-label="Your attempt" /></div>
                  <figcaption>You</figcaption>
                </figure>
                {teacherSrc && (
                  <figure>
                    <div className="try-frame"><video ref={teacher} src={teacherSrc} playsInline muted loop aria-label="The teacher, walked all the way around" /></div>
                    <figcaption>Teacher</figcaption>
                  </figure>
                )}
              </div>
              <div className="try-actions">
                <button className="btn secondary" onClick={playBoth}>Play both</button>
                <button className="btn secondary" onClick={pauseBoth}>Pause</button>
              </div>
            </>
          )}
          {feedback.summary && <p className="try-summary">{feedback.summary}</p>}
          {notes.length > 0 ? (
            <ol className="try-notes" aria-label="Notes on your attempt">
              {notes.map((n, i) => (
                <li key={i}>
                  <button
                    className={i === active ? "on" : ""}
                    onClick={() => seek(i, n)}
                    aria-current={i === active ? "true" : undefined}
                    aria-label={`${n.tone === "good" ? "Good" : "Fix"}, at ${n.attemptT.toFixed(1)} seconds: ${n.title}. ${n.note} Jump to it.`}
                  >
                    <span className="plan-t num">{n.attemptT.toFixed(1)} s</span>
                    <span>
                      <b>{n.title}</b>
                      <span>{n.note}</span>
                    </span>
                    <span className={`try-tone ${n.tone}`}>{n.tone === "good" ? "Good" : "Fix"}</span>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            !feedback.summary && <p className="note">Nothing to add on that one.</p>
          )}
          <p className="note">
            {showVideos
              ? "Tap a note to see that moment in both videos. "
              : notes.length > 0
                ? "From your last attempt; the video isn't kept. "
                : ""}
            {feedback.seen ? "Added to the plan as feedback. " : ""}
            Checked by Gemini, which only judges the movement and never identifies anyone.
          </p>
        </div>
      )}
      {(phase === "idle" || phase === "done") && (
        <>
          <p className="try-lede">
            {feedback ? "Try again whenever you like." : "Record yourself doing the move. Gemini compares it with the teacher and gives you notes, with times."}
          </p>
          <div className="try-actions">
            {secure ? (
              <button className="btn" onClick={openCamera}>{feedback ? "Record another try" : "Record an attempt"}</button>
            ) : (
              <label className="btn file-btn">
                Record with your camera
                <input type="file" accept="video/*" capture="user" onChange={(e) => fromFile(e.target.files?.[0])} />
              </label>
            )}
          </div>
          {!secure && (
            <p className="note">This browser only opens its camera on a secure page, so this opens your camera app instead. Open the page on the Mac itself to record here.</p>
          )}
          <p className="note">
            Nothing is sent until you press Get notes. Then your video goes to Gemini once, is deleted there and on this Mac, and only the notes stay.
          </p>
        </>
      )}

    </section>
  );
}

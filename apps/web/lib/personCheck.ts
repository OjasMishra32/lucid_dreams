// "One person, head to toe, filling the frame": checked in the browser with MediaPipe's pose model, before upload.
// The model loads on first use from Google's CDN (about 19 MB, cached by the browser after that). It only ever warns,
// never blocks: a model's guess shouldn't stop someone bringing in an old family photo.

import type { NormalizedLandmark, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { Check } from "./clipCheck";

const VERSION = "1.1.1"; // keep in step with @mediapipe/tasks-vision in package.json
const WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm`;
const MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

const HEAD = [0, 2, 5, 7, 8]; // nose, eyes, ears
const FEET = [27, 28, 29, 30, 31, 32]; // ankles, heels, toes
const MIN_PERSON = 0.15; // ignore detections shorter than this share of the frame (posters, people far behind)
const SMALL = 0.4; // nose-to-heel under this share of the frame height: they should move closer

let loading: Promise<PoseLandmarker> | null = null;
export function landmarker(): Promise<PoseLandmarker> {
  if (!loading) {
    loading = (async () => {
      const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
      const files = await FilesetResolver.forVisionTasks(WASM);
      const make = (delegate: "GPU" | "CPU") =>
        PoseLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: MODEL, delegate },
          runningMode: "IMAGE",
          numPoses: 3,
        });
      return make("GPU").catch(() => make("CPU"));
    })();
    loading.catch(() => (loading = null)); // offline for a moment: the next file can try again
  }
  return loading;
}

export interface Look {
  people: number;
  head: boolean;
  feet: boolean;
  height: number; // the biggest person's nose-to-heel span, as a share of the frame height
  centre: [number, number]; // where the biggest person is, as shares of the frame (a cut or a pan moves it at once)
  confidence: number; // how sure the model is it's a person (mean landmark visibility)
}

function extent(p: NormalizedLandmark[]): number {
  const ys = p.filter((v) => v.visibility > 0.5).map((v) => v.y);
  return ys.length ? Math.min(1, Math.max(...ys)) - Math.max(0, Math.min(...ys)) : 0;
}

export function look(model: PoseLandmarker, image: TexImageSource): Look {
  const people = model.detect(image).landmarks.filter((p) => extent(p) >= MIN_PERSON);
  if (!people.length) return { people: 0, head: false, feet: false, height: 0, centre: [0, 0], confidence: 0 };
  const main = people.reduce((a, b) => (extent(b) > extent(a) ? b : a));
  const inFrame = (i: number) => {
    const v = main[i];
    return !!v && v.visibility > 0.5 && v.x >= 0 && v.x <= 1 && v.y >= 0 && v.y <= 1;
  };
  const seen = main.filter((v) => v.visibility > 0.5);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
  return {
    people: people.length,
    head: HEAD.some(inFrame),
    feet: FEET.some(inFrame),
    height: extent(main),
    centre: [mean(seen.map((v) => v.x)), mean(seen.map((v) => v.y))],
    confidence: mean(main.map((v) => v.visibility)),
  };
}

/** Pose checks for a photo, or for three frames across the chosen 5-second window of a clip. Null if the model can't load. */
export async function personChecks(
  media: "video" | "photo",
  url: string,
  window: { startS: number; lengthS: number } = { startS: 0, lengthS: 0 },
): Promise<Check[] | null> {
  let model: PoseLandmarker;
  try {
    model = await landmarker();
  } catch {
    return null;
  }

  try {
    return describe(media, await looks(model, media, url, window));
  } catch {
    return null; // a file this browser can't decode: the other checks already say so
  }
}

async function looks(model: PoseLandmarker, media: "video" | "photo", url: string, window: { startS: number; lengthS: number }): Promise<Look[]> {
  let looks: Look[];
  if (media === "photo") {
    const img = new Image();
    const loaded = once(img, "load"); // not img.decode(): it can wait forever in a background tab
    img.src = url;
    if (!(img.complete && img.naturalWidth)) await loaded;
    looks = [look(model, img)];
  } else {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.src = url;
    await once(v, "loadeddata");
    looks = [];
    for (const f of [0.2, 0.5, 0.8]) {
      v.currentTime = Math.min(window.startS + f * window.lengthS, Math.max(0, v.duration - 0.05));
      await once(v, "seeked");
      looks.push(look(model, v));
    }
    v.removeAttribute("src");
    v.load();
  }
  return looks;
}

function describe(media: "video" | "photo", looks: Look[]): Check[] {
  const most = (pick: (l: Look) => boolean) => looks.filter(pick).length * 2 > looks.length;
  const people = Math.max(...looks.map((l) => l.people));
  const seen = looks.filter((l) => l.people > 0);
  const photo = media === "photo";

  if (!seen.length) {
    return [{
      level: "warn",
      title: "We can't find a person",
      detail: photo ? "Use a photo of one person, head to toe, facing the camera." : "Make sure one person is clearly in frame, head to toe.",
    }];
  }

  const checks: Check[] = [];
  if (people > 1) {
    checks.push({
      level: "warn",
      title: `We see ${people} people`,
      detail: photo ? "Crop the photo to just the person you want to bring in." : "We rebuild the biggest one. A clip with just them works best.",
    });
  }
  const head = most((l) => l.head);
  const feet = most((l) => l.feet);
  if (head && feet) {
    if (people === 1) checks.push({ level: "ok", title: "One person, head to toe", detail: "Exactly what we need." });
  } else {
    checks.push({
      level: "warn",
      title: !feet && !head ? "Part of them is out of frame" : !feet ? "Their feet are out of frame" : "Their head is cut off",
      detail: photo ? "Use a photo that shows them head to toe." : "Step back so they're in frame head to toe the whole time.",
    });
  }
  const heights = seen.map((l) => l.height).sort((a, b) => a - b);
  if (heights[Math.floor(heights.length / 2)] < SMALL) {
    checks.push({
      level: "warn",
      title: "They're small in the frame",
      detail: photo ? "Crop closer so they fill most of the photo." : "Move closer so they fill most of the frame: every pixel of them counts.",
    });
  }
  return checks;
}

function once(el: HTMLElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 8000);
    el.addEventListener(event, () => (clearTimeout(timer), resolve()), { once: true });
  });
}

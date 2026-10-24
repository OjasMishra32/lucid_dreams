// Several photos of one person: the best head-to-toe one builds the body, every other one goes to the face model
// (LAM: one photo becomes a 3D head). Each photo is checked in the browser before upload: MediaPipe's pose model counts
// the people and sees how much of them is in frame; its face detector confirms a face, on a crop around the head when
// the face is too small to find in a full-length photo. Photos with no face, or with two people, are left out.

import type { FaceDetector, NormalizedLandmark } from "@mediapipe/tasks-vision";
import { WASM, landmarker, people, summarize, type Look } from "./personCheck";

export const MAX_PHOTOS = 10;
const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const FACE_SCORE = 0.6;
const FACE_POINTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; // pose landmarks on the face: nose, eyes, ears, mouth
const CROP_PX = 384;

export interface PhotoLook extends Look {
  faces: number; // faces the detector found (a tiny one far behind the person doesn't count)
  face: boolean; // their face is there, found whole-photo or on the crop around their head
}

/** Why a photo is left out, or null when it can be used. */
export function leftOut(l: PhotoLook): string | null {
  if (l.people > 1 || l.faces > 1) return "Two people";
  if (!l.face) return "No face";
  return null;
}

/** How good a body photo it is: one person, head to toe, filling the frame. */
export function bodyScore(l: PhotoLook): number {
  if (leftOut(l)) return -1;
  return (l.head && l.feet ? 1 : 0) + l.height;
}

let loading: Promise<FaceDetector> | null = null;
function faceDetector(): Promise<FaceDetector> {
  if (!loading) {
    loading = (async () => {
      const { FilesetResolver, FaceDetector } = await import("@mediapipe/tasks-vision");
      const files = await FilesetResolver.forVisionTasks(WASM);
      const make = (delegate: "GPU" | "CPU") =>
        FaceDetector.createFromOptions(files, {
          baseOptions: { modelAssetPath: FACE_MODEL, delegate },
          runningMode: "IMAGE",
          minDetectionConfidence: FACE_SCORE,
        });
      return make("GPU").catch(() => make("CPU"));
    })();
    loading.catch(() => (loading = null));
  }
  return loading;
}

/** Look at one photo. Null when the models can't load or this browser can't decode the photo (HEIC in Chrome). */
export async function lookAt(url: string): Promise<PhotoLook | null> {
  let img: HTMLImageElement;
  try {
    img = await loadImage(url);
  } catch {
    return null;
  }
  let pose: Awaited<ReturnType<typeof landmarker>>;
  let faces: FaceDetector;
  try {
    [pose, faces] = await Promise.all([landmarker(), faceDetector()]);
  } catch {
    return null;
  }
  const all = pose.detect(img).landmarks;
  const summary = summarize(all);
  const found = countFaces(faces, img);
  let face = found > 0;
  if (!face) {
    // a full-length photo: the face is a few dozen pixels, below what the detector sees whole-photo. Look again on a
    // square crop around where the pose model put their head.
    const crop = headCrop(img, people(all).main);
    face = !!crop && countFaces(faces, crop) > 0;
  }
  return { ...summary, faces: found, face };
}

function countFaces(model: FaceDetector, image: TexImageSource): number {
  const boxes = model
    .detect(image)
    .detections.filter((d) => (d.categories[0]?.score ?? 0) >= FACE_SCORE && d.boundingBox)
    .map((d) => d.boundingBox!.width * d.boundingBox!.height);
  const biggest = Math.max(0, ...boxes);
  return boxes.filter((a) => a >= biggest * 0.15).length; // a face on a poster far behind them isn't a second person
}

function headCrop(img: HTMLImageElement, main: NormalizedLandmark[] | null): HTMLCanvasElement | null {
  if (!main) return null;
  const pts = FACE_POINTS.map((i) => main[i]).filter((v) => v && v.visibility > 0.4);
  if (pts.length < 3) return null;
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const xs = pts.map((v) => v.x * W);
  const ys = pts.map((v) => v.y * H);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 8);
  const side = Math.min(span * 3.2, W, H);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = CROP_PX;
  canvas.getContext("2d")?.drawImage(img, cx - side / 2, cy - side / 2, side, side, 0, 0, CROP_PX, CROP_PX);
  return canvas;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error("timed out")), 8000);
    img.onload = () => (clearTimeout(timer), resolve(img)); // not img.decode(): it can wait forever in a background tab
    img.onerror = () => (clearTimeout(timer), reject(new Error("unreadable")));
    img.src = url;
  });
}

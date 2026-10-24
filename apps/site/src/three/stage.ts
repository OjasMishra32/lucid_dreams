import * as THREE from "three";
import { SparkRenderer } from "@sparkjsdev/spark";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One canvas, one scene. It only renders while its host is on screen. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly spark: SparkRenderer | null = null;
  width = 1;
  height = 1;
  onScreen = false;
  private observer: IntersectionObserver;

  constructor(
    readonly host: HTMLElement,
    opts: { splats?: boolean; antialias?: boolean; fov?: number; maxDpr?: number } = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: opts.antialias ?? false, alpha: true, powerPreference: "high-performance" });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, opts.maxDpr ?? 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(opts.fov ?? 30, 1, 0.05, 100);
    if (opts.splats) {
      this.spark = new SparkRenderer({ renderer: this.renderer });
      this.scene.add(this.spark);
    }
    this.observer = new IntersectionObserver(([e]) => (this.onScreen = e.isIntersecting), { rootMargin: "80px 0px" });
    this.observer.observe(host);
    this.resize();
  }

  /** Reads the host's size; returns true when it changed. */
  resize(): boolean {
    const w = Math.max(1, Math.round(this.host.clientWidth));
    const h = Math.max(1, Math.round(this.host.clientHeight));
    if (w === this.width && h === this.height) return false;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    return true;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  /** A rect of another element, in this canvas's pixels. */
  rectOf(el: Element): Rect {
    const a = this.host.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    return { x: b.left - a.left, y: b.top - a.top, w: b.width, h: b.height };
  }

  /**
   * Point the camera's optical axis at the centre of `rect` (canvas pixels) instead of the canvas centre, without
   * tilting the camera: an off-axis projection, the way a shift lens frames a building without converging lines.
   */
  aimAt(rect: Rect) {
    const sx = rect.x + rect.w / 2 - this.width / 2;
    const sy = rect.y + rect.h / 2 - this.height / 2;
    const fullW = this.width + 2 * Math.abs(sx);
    const fullH = this.height + 2 * Math.abs(sy);
    this.camera.aspect = fullW / fullH;
    this.camera.setViewOffset(fullW, fullH, sx > 0 ? 0 : -2 * sx, sy > 0 ? 0 : -2 * sy, this.width, this.height);
    this.camera.updateProjectionMatrix();
    return fullH;
  }

  /** Camera distance at which a subject `width` x `height` meters fills `fill` of the rect (call after aimAt). */
  fitBoth(width: number, height: number, rect: Rect, fullH: number, fill = 1) {
    const pxPerMeterAt1 = fullH / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    return Math.max((height * pxPerMeterAt1) / (rect.h * fill), (width * pxPerMeterAt1) / (rect.w * fill));
  }

  dispose() {
    this.observer.disconnect();
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

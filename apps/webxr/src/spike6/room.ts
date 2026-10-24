import * as THREE from "three";

/**
 * AR-opaque: an immersive-ar session drawn fully opaque, so it looks like VR. In alpha-blend sessions three clears to
 * (0,0,0,0) whatever the clear colour, so the opacity comes from the set itself (the arena's 60 m dome covers every
 * direction). "See my room" lowers `level` from 1 to 0: every set material (except what `keep` names, and its children)
 * fades, so the passthrough shows while the splats stay; the clear colour follows for sessions that do use it. Fading
 * needs transparent materials (the page fades them once during the settle, so their shaders are compiled early).
 */
export class RoomFade {
  level = 1;
  private mats: { m: THREE.Material; opacity: number; transparent: boolean }[] = [];

  constructor(private renderer: THREE.WebGLRenderer, root: THREE.Object3D, keep: (o: THREE.Object3D) => boolean, private clear: THREE.Color) {
    const visit = (o: THREE.Object3D) => {
      if (keep(o)) return;
      const material = (o as THREE.Mesh).material;
      for (const m of material ? [material].flat() : []) {
        if (!this.mats.some((x) => x.m === m)) this.mats.push({ m, opacity: m.opacity, transparent: m.transparent });
      }
      o.children.forEach(visit);
    };
    visit(root);
  }

  set(level: number) {
    level = Math.min(1, Math.max(0, level));
    if (level === this.level) return;
    this.level = level;
    for (const x of this.mats) {
      const transparent = level < 1 || x.transparent;
      if (x.m.transparent !== transparent) {
        x.m.transparent = transparent;
        x.m.needsUpdate = true;
      }
      x.m.opacity = x.opacity * level;
    }
    this.renderer.setClearColor(this.clear, level);
  }
}

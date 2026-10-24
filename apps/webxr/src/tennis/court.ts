import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// A regulation grass court, built from code at real size. Court space: meters, +Y up, the net's centre at the origin,
// your half on +z (you stand behind the baseline at z = +11.885 facing -z), the opponent's half on -z. Your right is
// +x. Lines lie inside the court's measurements (the outer edge of a line is the boundary), as the rules draw them.

export const C = {
  halfL: 11.885, // baseline to the net
  halfS: 4.115, // singles sideline from the centre
  halfD: 5.485, // doubles sideline
  service: 6.4, // service line from the net
  line: 0.05,
  baseline: 0.1,
  netCentre: 0.914,
  netPost: 1.07,
  stickX: 4.115 + 0.914, // singles sticks, 0.914 m outside the singles sideline
  postX: 5.485 + 0.914, // net posts
  backRun: 6.4,
  sideRun: 3.66,
};
export const WALL_Z = C.halfL + C.backRun;
export const WALL_X = C.halfD + C.sideRun;

/** The net cord's height at x: 0.914 m at the centre strap, 1.07 m at the singles sticks and beyond. */
export function netHeight(x: number): number {
  const ax = Math.abs(x);
  if (ax >= C.stickX) return C.netPost;
  const u = ax / C.stickX;
  return C.netCentre + (C.netPost - C.netCentre) * (0.82 * u + 0.18 * u * u); // a slight sag between strap and stick
}

/** In the singles court: any part of the ball's contact patch on the line is in. */
export function inCourt(x: number, z: number, patch: number): boolean {
  return Math.abs(x) - patch <= C.halfS && Math.abs(z) - patch <= C.halfL;
}

/**
 * In the service box that the receiver standing on side `receiver` (+1: your half, -1: theirs) defends, deuce (their
 * right half) or ad. Half the centre service line belongs to each box.
 */
export function inServiceBox(x: number, z: number, patch: number, receiver: 1 | -1, deuce: boolean): boolean {
  const depth = z * receiver;
  if (depth < -patch || depth - patch > C.service) return false;
  if (Math.abs(x) - patch > C.halfS) return false;
  const xs = x * receiver; // > 0 on the receiver's right (the deuce court)
  return deuce ? xs + C.line / 2 + patch >= 0 : xs - C.line / 2 - patch <= 0;
}

// ---------------------------------------------------------------- textures

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * The lawn from wall to wall: mown stripes across the court, fine speckle of the blades, and the worn, sandy patches
 * where players stand behind the baselines and where servers and returners plant their feet.
 */
function grassTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const W = 1024;
  const H = 2048;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const r = rng(11);
  const mx = (x: number) => ((x + WALL_X) / (2 * WALL_X)) * W; // court x -> canvas
  const mz = (z: number) => ((z + WALL_Z) / (2 * WALL_Z)) * H;
  g.fillStyle = "#4c8a35";
  g.fillRect(0, 0, W, H);
  // mown stripes, parallel to the net, about 1.45 m each
  const stripe = (2 * WALL_Z) / 26;
  for (let k = 0; k < 26; k++) {
    g.fillStyle = k % 2 ? "rgba(255,255,230,0.075)" : "rgba(0,30,0,0.06)";
    g.fillRect(0, (k * stripe / (2 * WALL_Z)) * H, W, (stripe / (2 * WALL_Z)) * H + 1);
  }
  // the blades: thousands of short strokes, lighter and darker
  for (let i = 0; i < 90000; i++) {
    const x = r() * W;
    const y = r() * H;
    const l = r();
    g.fillStyle = l < 0.5 ? `rgba(20,60,12,${0.12 + r() * 0.15})` : `rgba(170,210,110,${0.06 + r() * 0.1})`;
    g.fillRect(x, y, 1, 1 + r() * 2.5);
  }
  // wear: sandy, thinned grass where the baseline rallies are played and the serves are struck
  const wear = (cx: number, cz: number, rx: number, rz: number, a: number) => {
    const x0 = mx(cx);
    const y0 = mz(cz);
    const sx = (rx / (2 * WALL_X)) * W;
    const sy = (rz / (2 * WALL_Z)) * H;
    g.save();
    g.translate(x0, y0);
    g.scale(sx, sy);
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    grad.addColorStop(0, `rgba(176,152,98,${a})`);
    grad.addColorStop(0.55, `rgba(150,140,86,${a * 0.55})`);
    grad.addColorStop(1, "rgba(120,130,70,0)");
    g.fillStyle = grad;
    g.beginPath();
    g.arc(0, 0, 1, 0, Math.PI * 2);
    g.fill();
    g.restore();
    // broken edges: patches of surviving grass inside the worn area
    for (let i = 0; i < 1400; i++) {
      const a2 = r() * Math.PI * 2;
      const d = Math.sqrt(r());
      const px = x0 + Math.cos(a2) * d * sx;
      const py = y0 + Math.sin(a2) * d * sy;
      g.fillStyle = r() < 0.6 ? `rgba(84,120,52,${0.25 * (1 - d) + 0.1})` : `rgba(196,172,118,${0.3 * (1 - d)})`;
      g.fillRect(px, py, 1 + r() * 3, 1 + r() * 3);
    }
  };
  for (const s of [1, -1]) {
    wear(0, s * (C.halfL + 0.6), 3.4, 1.7, 0.75);
    wear(0, s * (C.halfL + 0.3), 1.3, 0.9, 0.55);
    wear(1.8, s * (C.halfL + 1.4), 1.2, 0.9, 0.35);
    wear(-1.8, s * (C.halfL + 1.4), 1.2, 0.9, 0.35);
    wear(0, s * (C.halfL - 1.2), 2.2, 1.0, 0.18);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

/** A knotted net's square mesh, about 4.5 cm squares: dark cord on nothing. */
function netTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 64, 64);
  g.fillStyle = "rgba(18,22,20,0.95)";
  g.fillRect(0, 0, 64, 5);
  g.fillRect(0, 0, 5, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

/** A treeline far beyond the court: soft, irregular crowns against the sky (alpha), in the distance's blue-green. */
function treeTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 2048;
  c.height = 256;
  const g = c.getContext("2d")!;
  const r = rng(5);
  for (let layer = 0; layer < 3; layer++) {
    g.fillStyle = ["#5f7d70", "#4b6a59", "#3a5845"][layer];
    for (let x = -40; x < 2100; x += 18 + r() * 26) {
      const h = 90 + r() * 110 - layer * 28;
      const w = 30 + r() * 50;
      g.beginPath();
      g.ellipse(x, 256 - h * 0.55, w, h * 0.55, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.fillRect(0, 200 - layer * 14, 2048, 80);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.x = 3;
  return tex;
}

// ---------------------------------------------------------------- geometry helpers

/** A non-indexed copy with a flat vertex colour, so differently coloured parts merge into one draw. */
function tinted(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const col = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.toArray(arr, i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  g.deleteAttribute("uv");
  return g;
}

/** A flat white rectangle on the ground, x0..x1 by z0..z1. */
function rect(x0: number, x1: number, z0: number, z1: number, y: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(Math.abs(x1 - x0), Math.abs(z1 - z0));
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  return g;
}

export interface Court {
  /** Everything in court space; add it to the court group. */
  group: THREE.Group;
  /** Your room (passthrough, the court overlaid) or the full venue around you. */
  setRoom(room: boolean): void;
}

export function buildCourt(renderer: THREE.WebGLRenderer): Court {
  const group = new THREE.Group();
  group.name = "court";

  // ---------- the lawn, wall to wall ----------
  const grassMat = new THREE.MeshLambertMaterial({ map: grassTexture(renderer) });
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(2 * WALL_X, 2 * WALL_Z), grassMat);
  grass.rotation.x = -Math.PI / 2;
  grass.renderOrder = -5;
  group.add(grass);

  // ---------- lines: one mesh ----------
  const Y = 0.0025;
  const L = C.line;
  const lines: THREE.BufferGeometry[] = [];
  for (const s of [1, -1]) {
    lines.push(rect(-C.halfD, C.halfD, s * (C.halfL - C.baseline), s * C.halfL, Y)); // baseline
    lines.push(rect(-C.halfS, C.halfS, s * (C.service - L), s * C.service, Y)); // service line
    lines.push(rect(-L / 2, L / 2, s * (C.halfL - C.baseline - 0.1), s * (C.halfL - C.baseline), Y)); // centre mark
    for (const x of [1, -1]) {
      lines.push(rect(x * (C.halfS - L), x * C.halfS, -C.halfL, C.halfL, Y)); // singles sideline
      lines.push(rect(x * (C.halfD - L), x * C.halfD, -C.halfL, C.halfL, Y)); // doubles sideline
    }
  }
  lines.push(rect(-L / 2, L / 2, -C.service, C.service, Y)); // centre service line
  const lineMat = new THREE.MeshLambertMaterial({ color: 0xf4f4ee, emissive: 0x3a3a38, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const lineMesh = new THREE.Mesh(mergeGeometries(lines.map((g) => g.toNonIndexed())), lineMat);
  group.add(lineMesh);

  // ---------- the net: mesh, tape, strap, posts and singles sticks ----------
  const N = 48;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const TAPE = 0.06;
  for (let i = 0; i <= N; i++) {
    const x = -C.postX + (2 * C.postX * i) / N;
    const top = netHeight(x) - TAPE * 0.6;
    pos.push(x, 0.02, 0, x, top, 0);
    uv.push(x / 0.045, 0.02 / 0.045, x / 0.045, top / 0.045);
    if (i < N) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const netGeo = new THREE.BufferGeometry();
  netGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  netGeo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  netGeo.setIndex(idx);
  const net = new THREE.Mesh(netGeo, new THREE.MeshBasicMaterial({ map: netTexture(renderer), transparent: true, side: THREE.DoubleSide, depthWrite: false, color: 0xffffff }));
  net.renderOrder = 10; // after the opponent's splats: they're behind the net from your side
  group.add(net);

  const hard: THREE.BufferGeometry[] = [];
  // the tape: a white band folded over the cord, both faces
  const tape = new THREE.BufferGeometry();
  const tp: number[] = [];
  const ti: number[] = [];
  for (let i = 0; i <= N; i++) {
    const x = -C.postX + (2 * C.postX * i) / N;
    const h = netHeight(x);
    tp.push(x, h - TAPE, 0.008, x, h, 0.008, x, h - TAPE, -0.008, x, h, -0.008);
    if (i < N) {
      const a = i * 4;
      ti.push(a, a + 4, a + 1, a + 1, a + 4, a + 5); // front
      ti.push(a + 2, a + 3, a + 6, a + 3, a + 7, a + 6); // back
      ti.push(a + 1, a + 5, a + 3, a + 3, a + 5, a + 7); // top
    }
  }
  tape.setAttribute("position", new THREE.Float32BufferAttribute(tp, 3));
  tape.setIndex(ti);
  tape.computeVertexNormals();
  hard.push(tinted(tape, 0xf7f7f2));
  const strap = new THREE.BoxGeometry(0.05, C.netCentre, 0.012);
  strap.translate(0, C.netCentre / 2, 0);
  hard.push(tinted(strap, 0xf7f7f2));
  const postGreen = 0x1f3b26;
  for (const s of [1, -1]) {
    const post = new THREE.CylinderGeometry(0.038, 0.042, C.netPost + 0.04, 14);
    post.translate(s * (C.postX + 0.03), (C.netPost + 0.04) / 2, 0);
    hard.push(tinted(post, postGreen));
    const cap = new THREE.SphereGeometry(0.045, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    cap.translate(s * (C.postX + 0.03), C.netPost + 0.04, 0);
    hard.push(tinted(cap, postGreen));
    const stick = new THREE.CylinderGeometry(0.017, 0.017, C.netPost, 10);
    stick.translate(s * C.stickX, C.netPost / 2, 0);
    hard.push(tinted(stick, 0xe8e8e2));
  }
  const hardMesh = new THREE.Mesh(mergeGeometries(hard), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  group.add(hardMesh);

  // ---------- the venue: the walls round the run-off, a far treeline, the sky ----------
  const venue = new THREE.Group();
  const walls: THREE.BufferGeometry[] = [];
  const WH = 2.6;
  const wallGreen = 0x1d3d29;
  for (const s of [1, -1]) {
    const back = new THREE.BoxGeometry(2 * WALL_X + 0.4, WH, 0.2);
    back.translate(0, WH / 2, s * (WALL_Z + 0.1));
    walls.push(tinted(back, wallGreen));
    const side = new THREE.BoxGeometry(0.2, WH, 2 * WALL_Z + 0.4);
    side.translate(s * (WALL_X + 0.1), WH / 2, 0);
    walls.push(tinted(side, wallGreen));
    // a lighter trim along the top of each wall
    const trimB = new THREE.BoxGeometry(2 * WALL_X + 0.45, 0.08, 0.24);
    trimB.translate(0, WH + 0.04, s * (WALL_Z + 0.1));
    walls.push(tinted(trimB, 0x2d5a3a));
    const trimS = new THREE.BoxGeometry(0.24, 0.08, 2 * WALL_Z + 0.45);
    trimS.translate(s * (WALL_X + 0.1), WH + 0.04, 0);
    walls.push(tinted(trimS, 0x2d5a3a));
    // tiers of empty seats behind the walls, dark and quiet
    for (let k = 0; k < 6; k++) {
      const tierB = new THREE.BoxGeometry(2 * WALL_X + 4 + k * 2, 0.45, 0.9);
      tierB.translate(0, WH + 0.25 + k * 0.45, s * (WALL_Z + 0.75 + k * 0.9));
      walls.push(tinted(tierB, k % 2 ? 0x31423a : 0x2a3a33));
      const tierS = new THREE.BoxGeometry(0.9, 0.45, 2 * WALL_Z + 2 + k * 2);
      tierS.translate(s * (WALL_X + 0.75 + k * 0.9), WH + 0.25 + k * 0.45, 0);
      walls.push(tinted(tierS, k % 2 ? 0x31423a : 0x2a3a33));
    }
  }
  // the umpire's chair at the net post on your left, white and empty
  const chair: [number, number, number, number, number, number][] = [
    [0.05, 1.8, 0.05, -0.32, 0.9, -0.28], [0.05, 1.8, 0.05, 0.32, 0.9, -0.28], [0.05, 1.8, 0.05, -0.32, 0.9, 0.28], [0.05, 1.8, 0.05, 0.32, 0.9, 0.28],
    [0.75, 0.06, 0.65, 0, 1.82, 0], [0.75, 0.6, 0.06, 0, 2.15, -0.3], [0.06, 0.3, 0.6, -0.36, 2.0, 0], [0.06, 0.3, 0.6, 0.36, 2.0, 0],
  ];
  for (const [w, h, d, x, y, z] of chair) {
    const b = new THREE.BoxGeometry(w, h, d);
    b.translate(-(C.postX + 1.1) + z, y, x);
    walls.push(tinted(b, 0xeeeeea));
  }
  const wallMesh = new THREE.Mesh(mergeGeometries(walls), new THREE.MeshLambertMaterial({ vertexColors: true }));
  venue.add(wallMesh);
  // grass beyond the walls, out to the treeline
  const outer = new THREE.Mesh(new THREE.CircleGeometry(150, 48), new THREE.MeshLambertMaterial({ color: 0x3f6a33 }));
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.02;
  venue.add(outer);
  const trees = new THREE.Mesh(
    new THREE.CylinderGeometry(120, 120, 22, 72, 1, true),
    new THREE.MeshBasicMaterial({ map: treeTexture(), transparent: true, alphaTest: 0.4, side: THREE.BackSide, depthWrite: true, fog: false }),
  );
  trees.position.y = 9;
  venue.add(trees);
  // a summer afternoon sky: pale at the horizon, deep overhead, brighter toward the sun
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(300, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { sun: { value: new THREE.Vector3(-0.72, 0.68, 0.12).normalize() } }, // high, off your left: never in your eyes on a toss
      vertexShader: "varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: `uniform vec3 sun; varying vec3 vDir;
        void main(){
          float h = clamp(vDir.y, -0.1, 1.0);
          vec3 horizon = vec3(0.86, 0.91, 0.95);
          vec3 zenith = vec3(0.30, 0.52, 0.82);
          vec3 col = mix(horizon, zenith, pow(max(h, 0.0), 0.55));
          float s = max(dot(normalize(vDir), sun), 0.0);
          col += vec3(1.0, 0.96, 0.88) * (pow(s, 3000.0) * 1.0 + pow(s, 60.0) * 0.08);
          if (vDir.y < 0.0) col = mix(horizon, vec3(0.42, 0.52, 0.42), clamp(-vDir.y * 6.0, 0.0, 1.0));
          gl_FragColor = vec4(col, 1.0); // already display colours
        }`,
    }),
  );
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  venue.add(sky);
  group.add(venue);

  return {
    group,
    setRoom(room: boolean) {
      venue.visible = !room;
      // in your room the lawn becomes a light green wash over your floor; the lines and the net stay solid
      grassMat.transparent = room;
      grassMat.opacity = room ? 0.32 : 1;
      grassMat.depthWrite = !room;
      grassMat.needsUpdate = true;
    },
  };
}

/** A soft round shadow (a decal on the grass), for the ball and the opponent's feet. */
export function blobShadow(size: number, alpha: number): THREE.Mesh {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, `rgba(0,0,0,${alpha})`);
  g.addColorStop(0.5, `rgba(0,0,0,${alpha * 0.45})`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.004;
  m.renderOrder = 2;
  return m;
}

// Checks the real-surface geometry (src/xr/planes.ts) without a headset: detected planes read from a stand-in XRFrame,
// the floor found, and where a chess board goes on a table (or doesn't): squared to the edge you face, the opponent's
// side clear of the table, too small / too deep / wrong height / a bed / behind you all refused.
//   node scripts/check_planes.ts
import * as THREE from "three";
import { fits, floorLevel, type Flat, inside, tableSpot, upFacing } from "../src/xr/planes.ts";

// the chess board's needs, as game.ts sets them (SQUARE 0.05, seated.ts's TABLE_EDGE = 0.218 + 0.18)
const SQUARE = 0.05;
const TABLE_EDGE = SQUARE * 4 + 0.018 + 0.18;
const FP = { left: SQUARE * 4 + 0.09, right: SQUARE * 4 + 0.14, near: SQUARE * 4 + 0.018, far: TABLE_EDGE - 0.04, farMax: TABLE_EDGE + 0.06, span: 0.22 };
const SEAT = SQUARE * 4 + 0.018 + 0.45; // their hips behind the board's centre

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};

/** A w x d rectangle centred at (cx, cz), turned by `turn` (radians about +Y), at height y. */
const rect = (cx: number, cz: number, w: number, d: number, y: number, label = "table", turn = 0): Flat => {
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  const pts = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, z]) => new THREE.Vector2(cx + c * x + s * z, cz - s * x + c * z));
  return { y, pts, label, area: w * d };
};
const local = (x: number, z: number, lx: number, lz: number, yaw: number) => new THREE.Vector2(x + Math.cos(yaw) * lx + Math.sin(yaw) * lz, z - Math.sin(yaw) * lx + Math.cos(yaw) * lz);
const head = new THREE.Vector3(0, 1.2, 0); // seated at the table
const ahead = new THREE.Vector3(0, -0.3, -1); // looking down at it
const floor = rect(0, 0, 6, 6, 0, "floor");

// 1. a 1.2 x 0.8 m table whose near edge is 0.3 m in front of you
{
  const t = rect(0, -0.7, 1.2, 0.8, 0.74);
  const spot = tableSpot([floor, t], head, ahead, FP);
  check("a desk in front of you takes the board", !!spot);
  if (spot) {
    check("board squared to the edge you face", Math.abs(Math.sin(spot.yaw)) < 1e-6 && Math.cos(spot.yaw) > 0.99, `yaw ${spot.yaw.toFixed(3)}`);
    check("board surface on the table", Math.abs(spot.y - 0.74) < 1e-9);
    const farEdge = -(-0.7 - 0.4) - -spot.z; // from the board's centre to the table's far edge
    check("the table ends where their hands rest, before their body", farEdge >= FP.far - 1e-6 && farEdge < FP.farMax, `${farEdge.toFixed(3)} m past the centre`);
    check("their chair is off the table", !inside(t.pts, spot.x, spot.z - SEAT));
    check("within reach", Math.hypot(spot.x, spot.z) < 0.9, `${Math.hypot(spot.x, spot.z).toFixed(2)} m`);
    check("fits() agrees", fits(t, spot.x, spot.z, spot.yaw, FP));
    check("fits() refuses it 40 cm to the side", !fits(t, spot.x + 0.4, spot.z, spot.yaw, FP));
  }
}

// 2. the same desk seen at an angle: still squared to its edge, not to your view
{
  const t = rect(0, -0.7, 1.2, 0.8, 0.74);
  const spot = tableSpot([t], head, new THREE.Vector3(0.45, -0.3, -1), FP);
  check("looking at it sideways still squares it to the edge", !!spot && Math.abs(Math.sin(spot.yaw)) < 1e-6, spot ? `yaw ${spot.yaw.toFixed(3)}` : "none");
}

// 3. a turned table (35 degrees), you facing its nearest side
{
  const turn = THREE.MathUtils.degToRad(35);
  const t = rect(0, -0.75, 1.0, 0.75, 0.72, "desk", turn);
  const spot = tableSpot([t], head, new THREE.Vector3(-Math.sin(turn), -0.3, -Math.cos(turn)), FP);
  const err = spot ? Math.abs(Math.atan2(Math.sin(spot.yaw - turn), Math.cos(spot.yaw - turn))) : NaN;
  check("a turned desk: the board turns with it", !!spot && err < 1e-3, spot ? `off by ${THREE.MathUtils.radToDeg(err).toFixed(2)} deg` : "none");
  if (spot) {
    const corners = [[-FP.left, -FP.far], [FP.right, -FP.far], [FP.right, FP.near], [-FP.left, FP.near]].map(([lx, lz]) => local(spot.x, spot.z, lx, lz, spot.yaw));
    check("everything on it lies on it", corners.every((p) => inside(t.pts, p.x, p.y)));
  }
}

// 4. refused
check("a small side table (0.5 x 0.5)", !tableSpot([rect(0, -0.6, 0.5, 0.5, 0.7)], head, ahead, FP));
check("a narrow one (0.55 wide)", !tableSpot([rect(0, -0.7, 0.55, 0.8, 0.74)], head, ahead, FP));
check("a deep dining table, 1.2 m across from you", !tableSpot([rect(0, -0.9, 1.8, 1.2, 0.75)], head, ahead, FP));
check("a coffee table (0.45 m)", !tableSpot([rect(0, -0.7, 1.2, 0.8, 0.45)], head, ahead, FP));
check("a kitchen counter (1.05 m)", !tableSpot([rect(0, -0.7, 1.2, 0.8, 1.05)], head, ahead, FP));
check("a bed at table height", !tableSpot([rect(0, -1.3, 1.6, 2.0, 0.62, "bed")], head, ahead, FP));
check("a table behind you", !tableSpot([rect(0, 0.7, 1.2, 0.8, 0.74)], head, ahead, FP));
check("a table 2 m away", !tableSpot([rect(0, -2.4, 1.2, 0.8, 0.74)], head, ahead, FP));
check("heights are from the floor found (floor 10 cm up: 0.74 is 0.64 over it)", !!tableSpot([rect(0, -0.7, 1.2, 0.8, 0.74)], head, ahead, FP, { floor: 0.1 }));
check("...and a 0.68 table over a floor 10 cm up is too low", !tableSpot([rect(0, -0.7, 1.2, 0.8, 0.68)], head, ahead, FP, { floor: 0.1 }));

// 5. the floor
check("the floor-labelled plane is the floor", floorLevel([rect(0, 0, 4, 4, 0.04, "floor"), rect(0, -0.7, 1.2, 0.8, 0.74)]) === 0.04);
check("no floor label: the biggest surface near y = 0", floorLevel([rect(0, 0, 4, 4, -0.05, ""), rect(0, -0.7, 1.2, 0.8, 0.74, "")]) === -0.05);
check("no floor found", floorLevel([rect(0, -0.7, 1.2, 0.8, 0.74)]) === null);

// 6. reading planes from a frame (a stand-in for XRFrame.detectedPlanes and getPose)
{
  const pose = (m: THREE.Matrix4) => ({ transform: { matrix: new Float32Array(m.elements) } });
  const at = (x: number, y: number, z: number, q = new THREE.Quaternion()) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1));
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 6);
  const square = [[-0.5, -0.3], [0.5, -0.3], [0.5, 0.3], [-0.5, 0.3]].map(([x, z]) => ({ x, y: 0, z, w: 1 }));
  const planes = [
    { orientation: "horizontal", semanticLabel: "table", polygon: square, space: at(0.2, 0.74, -0.8, turn) },
    { orientation: "horizontal", semanticLabel: "ceiling", polygon: square, space: at(0, 2.5, 0, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI)) },
    { orientation: "vertical", semanticLabel: "wall", polygon: square, space: at(0, 1.2, -2, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)) },
  ].map((p) => ({ orientation: p.orientation, semanticLabel: p.semanticLabel, polygon: p.polygon, planeSpace: p.space, lastChangedTime: 0 }));
  const frame = { detectedPlanes: new Set(planes), getPose: (space: THREE.Matrix4) => pose(space) } as unknown as XRFrame;
  const flats = upFacing(frame, {} as XRReferenceSpace);
  check("ceiling and wall left out", flats.length === 1 && flats[0].label === "table");
  if (flats[0]) {
    const want = new THREE.Vector3(0.5, 0, -0.3).applyQuaternion(turn).add(new THREE.Vector3(0.2, 0, -0.8));
    const got = flats[0].pts[1];
    check("outline in the room's space", Math.abs(got.x - want.x) < 1e-6 && Math.abs(got.y - want.z) < 1e-6 && Math.abs(flats[0].y - 0.74) < 1e-6, `(${got.x.toFixed(3)}, ${got.y.toFixed(3)})`);
    check("area", Math.abs(flats[0].area - 0.6) < 1e-6, flats[0].area.toFixed(3));
  }
  check("no plane detection: nothing", upFacing({ getPose: () => null } as unknown as XRFrame, {} as XRReferenceSpace).length === 0);
  check("a frame that throws on detectedPlanes: nothing", upFacing(Object.defineProperty({}, "detectedPlanes", { get: () => { throw new Error("not active"); } }) as XRFrame, {} as XRReferenceSpace).length === 0);
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);

import * as THREE from "three";
import { textureBytes } from "./textures";

const LENGTH = 28.65;
const WIDTH = 15.24;
const KEY_X = 5.5; // the players stand 5.5 m from the baseline, inside the paint

function canvasMap(width: number, height: number, paint: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  paint(element.getContext("2d")!);
  const map = new THREE.CanvasTexture(element);
  map.colorSpace = THREE.SRGBColorSpace;
  return map;
}

function radial(size: number, stops: [number, string][]): THREE.CanvasTexture {
  return canvasMap(size, size, (ctx) => {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    stops.forEach(([at, color]) => g.addColorStop(at, color));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  });
}

/**
 * The VR arena around the court group's origin: the whole court, three curved tiers of stands in front of the seat,
 * light pools and fixture glows, and a falloff to black. Everything is unlit, alpha-blended or additive, so the cost is
 * mostly fill rate, which is what the headset run is meant to expose.
 */
export function makeArena(floorMap: THREE.CanvasTexture, standsMap: THREE.CanvasTexture) {
  const group = new THREE.Group();
  group.name = "arena";

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(LENGTH, WIDTH), new THREE.MeshBasicMaterial({ map: floorMap }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.x = LENGTH / 2 - KEY_X;
  group.add(floor);

  // stands: three bands of a cylinder stepping back and up, each wearing a third of the 4K crowd texture
  const standsMat = new THREE.MeshBasicMaterial({ map: standsMap, side: THREE.BackSide });
  // beyond the 15 m video sphere, so the video screen is always in front of the seats
  const tiers = [{ radius: 16, y: 0.5 }, { radius: 18, y: 4.5 }, { radius: 20, y: 8.5 }];
  const arc = 1.9; // radians: about 32 m of seats at 17 m
  tiers.forEach((tier, i) => {
    const geometry = new THREE.CylinderGeometry(tier.radius, tier.radius, 4, 64, 1, true, -arc / 2, arc);
    const uv = geometry.attributes.uv;
    for (let k = 0; k < uv.count; k++) {
      uv.setX(k, 1 - uv.getX(k)); // seen from inside, so the crowd and its lettering read the right way round
      uv.setY(k, (uv.getY(k) + i) / tiers.length);
    }
    const band = new THREE.Mesh(geometry, standsMat);
    // centred on the seat (1.6 m behind the origin); the arc sits at +Z, seats facing the court
    band.position.set(0, tier.y + 2, -1.6);
    group.add(band);
  });

  // six light pools on the floor, six fixture glows above them
  const pool = radial(256, [[0, "rgba(255,236,200,0.55)"], [0.5, "rgba(255,226,180,0.22)"], [1, "rgba(255,220,170,0)"]]);
  const glow = radial(128, [[0, "rgba(255,248,230,1)"], [0.25, "rgba(255,238,200,0.55)"], [1, "rgba(255,230,180,0)"]]);
  const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };
  const poolMat = new THREE.MeshBasicMaterial({ map: pool, ...additive });
  const glowMat = new THREE.SpriteMaterial({ map: glow, ...additive });
  const lights: [number, number, number][] = [[0, 0, 7], [-3.5, 4, 5], [4.5, -4, 5], [11, 0, 6], [16, 4, 5], [21, -3, 5]];
  for (const [x, z, size] of lights) {
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(size, size), poolMat);
    quad.rotation.x = -Math.PI / 2;
    quad.position.set(x, 0.004, z);
    quad.renderOrder = 1;
    group.add(quad);
    const sprite = new THREE.Sprite(glowMat);
    sprite.scale.setScalar(2.2);
    sprite.position.set(x, 9, z);
    sprite.renderOrder = 3;
    group.add(sprite);
  }

  // darkness: a ring on the floor that fades the court to black, and a dome whose horizon barely glows
  const falloff = radial(256, [[0, "rgba(0,0,0,0)"], [0.32, "rgba(0,0,0,0)"], [0.7, "rgba(2,3,6,0.9)"], [1, "rgba(2,3,6,1)"]]);
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), new THREE.MeshBasicMaterial({ map: falloff, transparent: true, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(6, 0.01, 0);
  ring.renderOrder = 2;
  group.add(ring);
  const sky = canvasMap(4, 256, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, "#03050a");
    g.addColorStop(0.5, "#0b1220");
    g.addColorStop(1, "#03050a");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, 256);
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(60, 24, 12), new THREE.MeshBasicMaterial({ map: sky, side: THREE.BackSide, depthWrite: false }));
  dome.renderOrder = -1;
  group.add(dome);
  return { group, textureBytes: [pool, glow, falloff, sky].reduce((sum, map) => sum + textureBytes(map), 0) };
}

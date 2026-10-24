import * as THREE from "three";
import { GroundedSkybox } from "three/addons/objects/GroundedSkybox.js";

// Places: one tap swaps your real room (passthrough) for a full 360-degree environment around the person: a concert
// hall around a pianist, a court around a shooter, a ring around a fighter. Each is a CC0 Poly Haven panorama
// (public/places/CREDITS.md) projected onto a sphere whose bottom is flattened into a real floor at y = 0, so the
// person stands on the place's floor (their contact shadow lands on it) and it stays put as you walk around them.
// "Your room" is no place at all: nothing is drawn behind the person and passthrough shows through.

export interface Place {
  id: string;
  name: string;
  file: string; // equirectangular panorama in public/places/
  /** The place's floor relative to its camera, meters: -1.6 means it was shot from 1.6 m up (the default). */
  floorY?: number;
  /** Radians about +Y that turn the interesting part (the stage, the corner) straight ahead of you, behind the person. */
  rotation?: number;
}

/** A rotation that brings the panorama's column u (0 = left edge, 1 = right edge) straight ahead of you. */
const ahead = (u: number) => 2 * Math.PI * (u - 0.25);

export const ROOM = "room"; // experience.json "environment": "room" keeps you in your own room

export const PLACES: Place[] = [
  { id: "concert-hall", name: "Concert hall", file: "concert-hall.webp", rotation: ahead(0.5) }, // the organ and the grand piano
  { id: "court", name: "Court", file: "court.webp", rotation: ahead(0.36) }, // down the court at sunset
  { id: "gym", name: "Gym", file: "gym.webp", rotation: ahead(0.62) },
  { id: "ring", name: "Boxing ring", file: "ring.webp", rotation: ahead(0.49) }, // the red corner
  { id: "studio", name: "Studio", file: "studio.webp", rotation: ahead(0.09) }, // the white cove, the lights behind you
  { id: "mountains", name: "Mountains", file: "mountains.webp", rotation: ahead(0.78) },
];

const FADE_S = 0.6;
const RADIUS = 30; // meters: the desktop camera and anyone walking around stay well inside
const DEFAULT_FLOOR_Y = -1.6;

export function placeById(id?: string | null): Place | null {
  return PLACES.find((p) => p.id === id) ?? null;
}

/** The place an intent suggests: piano or music -> the concert hall, basketball -> the court, a fight -> the ring. */
export function placeForIntent(intent?: string | null): Place | null {
  const said = intent?.toLowerCase() ?? "";
  if (!said) return null;
  if (/\b(piano|pianist|keyboard|music|musician|concert|recital|orchestra|instrument|guitar|violin|cello|ukulele|drums?|sing|singing|song)\b/.test(said)) return placeById("concert-hall");
  if (/\b(box|boxing|boxer|fight|fighter|fighting|punch\w*|jab|uppercut|spar\w*|kickbox\w*|mma|martial|karate|taekwondo)\b/.test(said)) return placeById("ring");
  if (/\b(basketball|shot|shoot\w*|jumper|dribbl\w*|layup|dunk\w*|hoop|free throw|crossover)\b/.test(said)) return placeById("court");
  if (/\b(workout|work out|gym|lift\w*|squat\w*|deadlift\w*|exercise|fitness|push-?ups?|pull-?ups?|burpees?|lunges?|kettlebell)\b/.test(said)) return placeById("gym");
  return null;
}

/**
 * Where the viewer starts: an explicit choice (?place= in the URL, or experience.json's "environment") wins, "room"
 * included; otherwise the intent picks one; otherwise your room.
 */
export function startingPlace(asked: string | null | undefined, intent: string | null | undefined): Place | null {
  if (asked === ROOM) return null;
  return placeById(asked) ?? placeForIntent(intent);
}

/** Your room -> each place in turn -> your room. */
export function nextPlace(current: Place | null): Place | null {
  const i = current ? PLACES.indexOf(current) : -1;
  return i + 1 < PLACES.length ? PLACES[i + 1] : null;
}

export const placeUrl = (p: Place) => `${import.meta.env.BASE_URL}places/${p.file}`;

interface Layer {
  place: Place;
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  texture: THREE.Texture;
  k: number; // 0 -> 1 fade progress
  leaving: boolean;
}

/**
 * The environment around the person. Anchored where you stand and turned the way you face (anchor()), so the place
 * is seen from its own camera position: undistorted from there, and the floor stays where it is as you move.
 * Changes crossfade over ~0.6 s; going back to your room fades the place out to the passthrough behind it.
 */
export class Places {
  readonly group = new THREE.Group();
  current: Place | null = null;
  onChange: (place: Place | null) => void = () => {};
  private layers: Layer[] = [];
  private request = 0;
  private loader: THREE.ImageBitmapLoader | THREE.TextureLoader;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.group.name = "place";
    if (typeof createImageBitmap === "function") {
      // decoded off the main thread, so a 4K panorama doesn't stall a frame in the headset
      const l = new THREE.ImageBitmapLoader();
      l.setOptions({ imageOrientation: "flipY", premultiplyAlpha: "none" });
      this.loader = l;
    } else this.loader = new THREE.TextureLoader();
  }

  /** Whether anything is drawn behind the person (a place, or one still fading out). */
  get visible(): boolean {
    return this.layers.length > 0;
  }

  /** Puts the place's camera where you stand (x, z) and its interesting side the way you're looking. */
  anchor(viewer: THREE.Vector3, forward: THREE.Vector3) {
    const fx = forward.x, fz = forward.z;
    this.group.position.set(viewer.x, 0, viewer.z);
    if (fx * fx + fz * fz > 1e-8) this.group.rotation.y = Math.atan2(-fx, -fz);
  }

  /** Switches to a place (null: your room). Resolves once it's on its way in. */
  async set(place: Place | null): Promise<void> {
    if (place === this.current) return;
    const previous = this.current;
    this.current = place;
    this.onChange(place);
    const ticket = ++this.request;
    if (!place) {
      for (const l of this.layers) l.leaving = true;
      return;
    }
    let texture: THREE.Texture;
    try {
      texture = await this.load(place);
    } catch (e) {
      console.warn(`Couldn't load the place ${place.id}.`, e);
      if (ticket === this.request) {
        this.current = previous;
        this.onChange(previous);
      }
      return;
    }
    if (ticket !== this.request) return void disposeTexture(texture); // already moved on to another place
    const skybox = new GroundedSkybox(texture, -(place.floorY ?? DEFAULT_FLOOR_Y), RADIUS);
    const material = skybox.material as THREE.MeshBasicMaterial;
    material.transparent = true;
    material.opacity = 0;
    material.toneMapped = false;
    material.fog = false;
    skybox.position.y = -(place.floorY ?? DEFAULT_FLOOR_Y); // its flattened bottom on our floor, y = 0
    skybox.rotation.y = place.rotation ?? 0;
    skybox.frustumCulled = false;
    // drawn before everything else and never in front of anything: the person, the props and the controls blend over it
    for (const l of this.layers) l.mesh.renderOrder = -1001;
    skybox.renderOrder = -1000;
    this.group.add(skybox);
    this.layers.push({ place, mesh: skybox, material, texture, k: 0, leaving: false });
    const next = nextPlace(place);
    if (next) fetch(placeUrl(next)).catch(() => {}); // warm the cache for the next tap
  }

  /** Advances the crossfade. */
  update(dt: number) {
    if (!this.layers.length) return;
    const step = dt / FADE_S;
    const top = this.layers[this.layers.length - 1];
    for (const l of this.layers) {
      // a place fades in over the one before it; only a lone place leaving fades itself out (back to your room)
      l.k = l.leaving ? Math.max(0, l.k - step) : Math.min(1, l.k + step);
      l.material.opacity = l.k * l.k * (3 - 2 * l.k);
    }
    // once the newest place is fully in, the ones under it can go
    const keep = !top.leaving && top.k >= 1 ? [top] : this.layers.filter((l) => !(l.leaving && l.k <= 0));
    for (const l of this.layers) if (!keep.includes(l)) this.drop(l);
    this.layers = keep;
  }

  private drop(l: Layer) {
    this.group.remove(l.mesh);
    l.mesh.geometry.dispose();
    l.material.dispose();
    disposeTexture(l.texture);
  }

  private async load(place: Place): Promise<THREE.Texture> {
    const url = placeUrl(place);
    let texture: THREE.Texture;
    if (this.loader instanceof THREE.ImageBitmapLoader) {
      const bitmap = await this.loader.loadAsync(url);
      texture = new THREE.Texture(bitmap);
      texture.flipY = false; // already flipped when decoded
      texture.needsUpdate = true;
    } else texture = await this.loader.loadAsync(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.mapping = THREE.UVMapping;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.renderer.initTexture(texture); // upload now, before the fade starts, rather than mid-fade
    return texture;
  }
}

function disposeTexture(t: THREE.Texture) {
  t.dispose();
  const img = t.image as { close?: () => void } | null;
  img?.close?.();
}

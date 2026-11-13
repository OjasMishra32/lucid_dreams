import type * as THREE from "three";

/** Leave the room for another page of the app (the library, the chess table): the immersive session ends first, since a
 * page can only start one from a press on the page itself. */
export function leaveTo(renderer: THREE.WebGLRenderer, href: string): void {
  const session = renderer.xr.getSession();
  if (session) void session.end().finally(() => location.assign(href));
  else location.assign(href);
}

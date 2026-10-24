import { dyno, type GsplatModifier, type SplatMesh } from "@sparkjsdev/spark";

// The person flipped left to right, so you can follow them like a mirror. Spark keeps only a uniform scale for a splat
// mesh (a negative x scale would shrink it), so the flip happens per Gaussian in the person's own space, after any
// skinning: x -> -x for the centre, and the same reflection on its orientation. A reflection F turns a rotation R into
// F R F, which for F = diag(-1, 1, 1) is the quaternion (x, -y, -z, w); the scales don't change. (Colour has no
// view-dependent part in our SPZ frames, so nothing else needs turning.)

/** One modifier per mesh: a Spark dyno holds its inputs, so the same one can't be shared between meshes. */
function mirrorX(): GsplatModifier {
  return new dyno.Dyno({
    inTypes: { gsplat: dyno.Gsplat },
    outTypes: { gsplat: dyno.Gsplat },
    statements: ({ inputs, outputs }) =>
      dyno.unindentLines(`
        ${outputs.gsplat} = ${inputs.gsplat};
        ${outputs.gsplat}.center.x = -${outputs.gsplat}.center.x;
        ${outputs.gsplat}.quaternion.yz = -${outputs.gsplat}.quaternion.yz;
      `),
  });
}

const mirrored = new WeakSet<SplatMesh>();

/** Flip (or unflip) one splat mesh left to right in its own space. */
export function setMirrored(mesh: SplatMesh, on: boolean) {
  if (on === mirrored.has(mesh)) return;
  if (on) mirrored.add(mesh);
  else mirrored.delete(mesh);
  mesh.objectModifier = on ? mirrorX() : undefined;
  mesh.updateGenerator();
}

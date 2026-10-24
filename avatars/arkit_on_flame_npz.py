"""ARKit's 52 blendshapes on FLAME's topology, out of LAM's chat-avatar template, in one small npz:

  PYTHONPATH=avatars $L/envs/a2e/bin/python avatars/arkit_on_flame_npz.py template_file.fbx flame2023_expr.npz \\
      arkit_on_flame.npz [--max-rms 0.04] [--list]

LAM's team fitted ARKit's shapes to FLAME's topology by hand; they ship as the morph targets of the template
`assets/sample_oac/template_file.fbx` (from `sample_oac.tar`, tools/AVATAR_EXPORT_GUIDE.md in aigc3d/LAM). The template
is an ASCII FBX that LAM's own tools/generateARKITGLBWithBlender.py reads with Autodesk's FBX SDK (their py3.10 wheel,
`fbx-2020.3.4-cp310-cp310-manylinux1_x86_64.whl`, installed into the python 3.10 env `envs/a2e` by hpg/lips.sbatch), so this does too.

What it does: reads every mesh that carries blendshape channels named like ARKit's (matched on the part after the last
`.` or `:`, ignoring case), takes the one with all 52, reads its base mesh and each channel's (last, full-weight)
target shape, makes deltas (arkit.shape_deltas), finds which FBX vertex is which FLAME vertex
(arkit.fit_to_flame: by index when the FBX's first vertices fit FLAME's template, else by nearest neighbour; it
**refuses** over 4% of the head's extent in RMS, so a reordered or foreign mesh never gets through), carries the
deltas into FLAME's frame and metres, and checks the jaw opens downward by centimetres. `--list` only prints what the
FBX holds (meshes, vertex counts, channel names), for when a name or a mesh isn't what this expects.

The npz holds LAM's assets and stays on HiPerGator, like the FLAME extract: never commit it.
"""

from __future__ import annotations

import argparse
import sys

import numpy as np

from lucid_avatars import arkit as A


def _walk(node):
    yield node
    for i in range(node.GetChildCount()):
        yield from _walk(node.GetChild(i))


def _blend_type(fbx):
    for get in (lambda: fbx.FbxDeformer.eBlendShape, lambda: fbx.FbxDeformer.EDeformerType.eBlendShape):
        try:
            return get()
        except AttributeError:
            continue
    raise RuntimeError("this FBX SDK binding has no FbxDeformer.eBlendShape")


def _points(geometry) -> np.ndarray:
    n = geometry.GetControlPointsCount()
    out = np.empty((n, 3))
    for i in range(n):
        p = geometry.GetControlPointAt(i)
        out[i] = (p[0], p[1], p[2])
    return out


def read_fbx(path: str) -> list[dict]:
    """Every mesh in the FBX: {"name", "base": (n, 3), "channels": {channel name: shape control points (n, 3)}}. A
    channel's shape is its last target: the one at full weight (earlier ones are in-betweens)."""
    import fbx  # Autodesk FBX SDK python binding (LAM's wheel), only in a python 3.10 env that has it (envs/a2e)

    manager = fbx.FbxManager.Create()
    manager.SetIOSettings(fbx.FbxIOSettings.Create(manager, fbx.IOSROOT))
    try:
        importer = fbx.FbxImporter.Create(manager, "")
        if not importer.Initialize(str(path), -1, manager.GetIOSettings()):
            raise RuntimeError(f"FBX import failed: {importer.GetStatus().GetErrorString()}")
        scene = fbx.FbxScene.Create(manager, "scene")
        importer.Import(scene)
        importer.Destroy()
        meshes = []
        blend = _blend_type(fbx)
        for node in _walk(scene.GetRootNode()):
            mesh = node.GetMesh()
            if mesh is None:
                continue
            channels = {}
            for d in range(mesh.GetDeformerCount(blend)):
                shapes = mesh.GetDeformer(d, blend)
                for c in range(shapes.GetBlendShapeChannelCount()):
                    ch = shapes.GetBlendShapeChannel(c)
                    if ch.GetTargetShapeCount():
                        channels[ch.GetName()] = _points(ch.GetTargetShape(ch.GetTargetShapeCount() - 1))
            meshes.append({"name": node.GetName(), "base": _points(mesh), "channels": channels})
        return meshes
    finally:
        manager.Destroy()


def arkit_channels(channels: dict) -> dict[str, np.ndarray]:
    """The channels named like ARKit's 52 (the part after the last '.' or ':', case ignored), by ARKit name."""
    lower = {n.lower(): n for n in A.ARKIT_NAMES}
    found = {}
    for name, pts in channels.items():
        key = name.replace(":", ".").rsplit(".", 1)[-1].lower()
        if key in lower:
            found[lower[key]] = pts
    return found


def extract(meshes: list[dict], template: np.ndarray, max_rms_rel: float) -> tuple[dict, dict]:
    """(npz arrays, report) from read_fbx's meshes and FLAME's v_template. ValueError says what's wrong."""
    full = [(m, arkit_channels(m["channels"])) for m in meshes]
    full = [(m, c) for m, c in full if len(c) == A.N_ARKIT]
    if not full:
        best = max((len(arkit_channels(m["channels"])) for m in meshes), default=0)
        raise ValueError(f"no mesh with all {A.N_ARKIT} ARKit channels (the best has {best}); rerun with --list")
    if len(full) > 1:
        raise ValueError(f"{len(full)} meshes carry all 52 ARKit channels ({[m['name'] for m, _ in full]}): "
                         "which is the face? rerun with --list")
    mesh, channels = full[0]
    base = mesh["base"]
    fit = A.fit_to_flame(base, template, max_rms_rel)  # raises when the correspondence isn't trustworthy
    pts = np.stack([channels[n] for n in A.ARKIT_NAMES])
    if pts.shape[1] != len(base):
        raise ValueError(f"shapes have {pts.shape[1]} vertices, the base mesh {len(base)}")
    deltas = A.deltas_on_flame(A.shape_deltas(base, pts), fit)
    problems = A.plausibility_problems(deltas, template)
    if problems:
        raise ValueError("the shapes don't look like ARKit on FLAME: " + "; ".join(problems))
    report = {"mesh": mesh["name"], "fbxVertices": int(len(base)), "route": fit.route,
              "rmsMm": round(fit.rms_m * 1000, 3), "rmsOverExtent": round(fit.rms_rel, 4),
              "distinct": round(fit.unique, 4), "unitScale": round(fit.k, 6),
              "jawOpenMaxMm": round(float(np.linalg.norm(deltas[A.ARKIT_NAMES.index("jawOpen")], axis=1).max() * 1000), 2),
              "maxDeltaMm": round(float(np.abs(deltas).max() * 1000), 2)}
    return {"names": np.array(A.ARKIT_NAMES), "deltas": deltas.astype(np.float32)}, report


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("fbx")
    ap.add_argument("flame_npz", nargs="?")
    ap.add_argument("out", nargs="?")
    ap.add_argument("--max-rms", type=float, default=A.MAX_RMS_REL)
    ap.add_argument("--list", action="store_true", help="print what the FBX holds and stop")
    args = ap.parse_args()
    meshes = read_fbx(args.fbx)
    if args.list or not (args.flame_npz and args.out):
        for m in meshes:
            names = list(m["channels"])
            print(f"mesh {m['name']!r}: {len(m['base'])} vertices, {len(names)} blendshape channels "
                  f"({len(arkit_channels(m['channels']))} ARKit-named) {names[:8]}")
        return 0
    from lucid_avatars.face_expr import load_flame

    arrays, report = extract(meshes, load_flame(args.flame_npz).v_template, args.max_rms)
    np.savez(args.out, **arrays)
    print(f"[arkit] {report}")
    print(f"[arkit] ARKit on FLAME: 52 shapes -> {args.out}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ValueError as e:
        print(f"[arkit] REFUSED: {e}")
        sys.exit(2)

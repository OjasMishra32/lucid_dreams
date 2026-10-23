# avatars

Vishal's area: photoreal, rigged people that can do any move. A photo or clip goes through DiGS-Avatar,
gets fine-tuned on 4DAnyone's generated views, and is exported as `avatar/avatar.ply` + `avatar/motion.json`
in a dream bundle (see `AGENTS.md`, Contracts).

## What's here

`lucid_avatars/` is plain numpy, so it runs anywhere, including the GPU environment:

| Module | Does |
| --- | --- |
| `motion.py` | `motion.json` read/write/validate; DiGS-Avatar packed SMPL-X <-> motion; turning a motion to face the viewer on the floor |
| `idle.py` | Seamless idle loop (breathing, weight shift, head sway) so a family-photo person never freezes |
| `gaussian_ply.py` | Standard 3DGS binary PLY read/write |
| `bundle.py` | Writes an avatar bundle; validates any bundle against the contract |

```bash
cd avatars
uv run --group dev pytest -q                                      # tests
uv run python -m lucid_avatars validate ../samples/<id>           # check a bundle
uv run python -m lucid_avatars idle motion.json --seconds 8       # write an idle motion
```

## motion.json conventions (proposed, to confirm with Ian)

- `root_t`, `root_q` are SMPL-X `transl` and `global_orient`, applied exactly the way SMPL-X applies them.
- `pose[0]` (pelvis) is always zero; the root rotation lives only in `root_q`, so it is never applied twice.
- `pose` holds absolute joint rotations, hands included (no hand-mean offset, no PCA).
- `avatar.ply` is in SMPL-X rest space (faces +Z); the 180-degree turn to face -Z is in `root_q`.

Open questions for the Quest side: how per-Gaussian skinning weights travel (extra PLY properties or a
side file), and whether `motion.json` gets an optional `expr` field so avatars can blink.

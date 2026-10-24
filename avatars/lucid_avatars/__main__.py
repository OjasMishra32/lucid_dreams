"""Command line: `python -m lucid_avatars validate dreams/<id>`, `... idle motion.json`, `... bake dreams/<id>`,
`... results <run>-tuned.work`, `... head-swap dreams/<id> heads/<person>/heads --person <person> ...`."""

import argparse
import sys

import numpy as np

from .bundle import validate_bundle
from .idle import idle_loop


def main() -> int:
    parser = argparse.ArgumentParser(prog="lucid_avatars")
    sub = parser.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate", help="check dream bundles against the AGENTS.md contract")
    v.add_argument("bundles", nargs="+")
    i = sub.add_parser("idle", help="write an idle-loop motion.json")
    i.add_argument("out")
    i.add_argument("--seconds", type=float, default=8.0)
    i.add_argument("--fps", type=int, default=30)
    i.add_argument("--stand-y", type=float, default=0.0, help="SMPL-X transl y that puts the soles on y = 0")
    b = sub.add_parser("bake", help="avatar bundle -> replay bundle (posed per frame) for players that can't skin")
    b.add_argument("bundle")
    b.add_argument("--id", help="new bundle id (default <id>-baked, next to the source)")
    b.add_argument("--fps", type=float, default=15.0)
    r = sub.add_parser("results", help="fine-tune work dir -> avatars/README.md Results section + avatars/results/")
    r.add_argument("work", help="the fine-tune's <run>-tuned.work dir (results.md, compare.png)")
    r.add_argument("--max-width", type=int, default=1600, help="renders wider than this are scaled down")
    h = sub.add_parser("head-swap", help="avatar bundle + LAM head -> <id>-head bundle (consenting people only)")
    h.add_argument("bundle", help="the person's own avatar bundle, dreams/<person>")
    h.add_argument("heads", help="lam-head.sbatch's heads/ folder for this person")
    h.add_argument("--person", required=True, help="who the face belongs to; must be in head_swap.CONSENTED")
    h.add_argument("--smplx", required=True, help="SMPLX_NEUTRAL.npz (the model DiGS used)")
    h.add_argument("--flame-ids", required=True, help="SMPL-X__FLAME_vertex_ids.npy")
    h.add_argument("--photo", help="which LAM head, <person>-<photo> (default the person's first)")
    h.add_argument("--id", help="new bundle id (default <id>-head, next to the source)")
    h.add_argument("--held", help="another dreams/.held to honour too (the one next to the bundle always counts)")
    h.add_argument("--seam-offset", type=float, default=0.0, help="move the jaw-line seam up (+) or down, metres")
    args = parser.parse_args()

    if args.cmd == "validate":
        failed = 0
        for b in args.bundles:
            errors = validate_bundle(b)
            print(f"{'FAIL' if errors else 'OK  '} {b}")
            for e in errors:
                print(f"     {e}")
            failed += bool(errors)
        return 1 if failed else 0
    if args.cmd == "bake":
        from pathlib import Path

        from .bake import bake_bundle

        src = Path(args.bundle)
        root = bake_bundle(src, src.parent, args.id or f"{src.name}-baked", fps=args.fps)
        errors = validate_bundle(root)
        print(f"{'FAIL' if errors else 'OK  '} {root}", *errors, sep="\n     ")
        return 1 if errors else 0
    if args.cmd == "results":
        from pathlib import Path

        from .results_page import fill

        here = Path(__file__).resolve().parents[1]
        for c in fill(args.work, here / "README.md", here / "results", args.max_width):
            print(f"wrote {c} ({c.stat().st_size // 1024} KB)")
        print(f"wrote {here / 'README.md'} (Results section)")
        return 0
    if args.cmd == "head-swap":
        from pathlib import Path

        from . import head_swap as H

        src = Path(args.bundle)
        new_id = args.id or f"{src.name}-head"
        refused = H.consent_errors(args.person, src, args.held, new_id)
        if not refused:
            try:
                ply, obj = H.pick_head(args.heads, args.person, args.photo)
            except ValueError as e:
                refused = [str(e)]
        if refused:
            print("REFUSED", *refused, sep="\n     ")
            return 2
        root = H.swap_bundle(src, ply, obj, args.smplx, args.flame_ids, src.parent, new_id,
                             seam_offset=args.seam_offset)
        errors = validate_bundle(root)
        print((root / "head_swap.json").read_text().strip())
        print(f"{'FAIL' if errors else 'OK  '} {root}", *errors, sep="\n     ")
        return 1 if errors else 0
    idle_loop(np.zeros(10), args.seconds, args.fps, args.stand_y).save(args.out)
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

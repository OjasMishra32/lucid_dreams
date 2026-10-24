"""Command line: `python -m lucid_avatars validate dreams/<id>`, `... idle motion.json`, `... bake dreams/<id>`."""

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
    idle_loop(np.zeros(10), args.seconds, args.fps, args.stand_y).save(args.out)
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

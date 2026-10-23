"""Command line: `python -m lucid_avatars validate dreams/<id>` or `python -m lucid_avatars idle motion.json`."""

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
    idle_loop(np.zeros(10), args.seconds, args.fps, args.stand_y).save(args.out)
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

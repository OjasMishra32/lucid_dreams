# Court Side: shared shell helpers, sourced by court-submit.sh and court-grid-hpg.sh. Needs L.
fail() { echo "PREFLIGHT FAIL: $*" >&2; exit 1; }

# preflight <id> [views_only]: $L/data/court/<id>/ holds a complete, self-consistent run that was never submitted.
# Sets K and FOCAL from its court-run.json and TURBO from its job.json.
preflight() {
  local id=$1 views_only=${2:-0} d=$L/data/court/$1 f
  [[ $id =~ ^court-[a-z0-9][a-z0-9-]*$ ]] || fail "id '$id'"
  for f in input.mp4 job.json court-run.json; do test -s "$d/$f" || fail "missing $d/$f"; done
  read -r K FOCAL TURBO < <(python3 - "$d" "$id" <<'PY'
import json, sys
d, rid = sys.argv[1], sys.argv[2]
r, j = json.load(open(f"{d}/court-run.json")), json.load(open(f"{d}/job.json"))
k, f = r.get("K"), r.get("FOCAL")
bad = [m for m, ok in [(f"court-run id {r.get('id')}", r.get("id") == rid), (f"job id {j.get('id')}", j.get("id") == rid),
                       (f"frames {j.get('frames')}", j.get("frames") == 121), (f"K {k}", isinstance(k, int) and 0 <= k <= 120),
                       (f"FOCAL {f}", isinstance(f, (int, float)) and f > 0),
                       (f"sourceFocal {j.get('sourceFocal')} vs FOCAL {f}", j.get("sourceFocal") == f)] if not ok]
print("BAD", "; ".join(bad)) if bad else print(k, f, int(bool(j.get("turbo"))))
PY
  ) || fail "cannot read $d/court-run.json and job.json"
  [ "$K" = BAD ] && fail "$id: $FOCAL $TURBO"
  [[ $K =~ ^[0-9]+$ ]] && (( K <= 120 )) || fail "K=$K"
  [[ $FOCAL =~ ^[0-9]+([.][0-9]+)?$ ]] || fail "FOCAL=$FOCAL"
  if [ "$views_only" != 1 ]; then
    local p
    p=$(printf '%06d' "$K")
    for f in source-4k.mkv "masks/$p.png" "ignore/$p.png"; do test -s "$d/$f" || fail "missing $d/$f"; done
  fi
  test -e "$L/runs/$id/logs/submitted" && fail "$id was submitted before ($(cat "$L/runs/$id/logs/submitted")); use a new id"
  return 0
}

# the group's free space in GB: Limit - Use on the group's blue line (units k/m/g/t, with or without a trailing b)
group_free_gb() {
  blue_quota | awk 'function b(s, u) { sub(/[bB]$/, "", s); u = tolower(substr(s, length(s)))
      return (s + 0) * (u == "k" ? 2^10 : u == "m" ? 2^20 : u == "g" ? 2^30 : u == "t" ? 2^40 : 1) }
    /^Storage quotas for group/ { g = 1; next } /^Storage quotas for user/ { g = 0 }
    g && $1 ~ /^blue/ { printf "%d", (b($4) - b($2)) / 2^30; exit }'
}

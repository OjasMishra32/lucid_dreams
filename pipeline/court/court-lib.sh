# Court Side: shared shell helpers, sourced by the login-node scripts (bash and awk only: no python there).
fail() { echo "PREFLIGHT FAIL: $*" >&2; exit 1; }

# the group's free space in GB: Limit - Use on the group's blue line (units k/m/g/t, with or without a trailing b)
group_free_gb() {
  blue_quota | awk 'function b(s, u) { sub(/[bB]$/, "", s); u = tolower(substr(s, length(s)))
      return (s + 0) * (u == "k" ? 2^10 : u == "m" ? 2^20 : u == "g" ? 2^30 : u == "t" ? 2^40 : 1) }
    /^Storage quotas for group/ { g = 1; next } /^Storage quotas for user/ { g = 0 }
    g && $1 ~ /^blue/ { printf "%d", (b($4) - b($2)) / 2^30; exit }'
}

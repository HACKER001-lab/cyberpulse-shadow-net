#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# CyberPulse: Shadow Net — Cloudflare Pages build step.
#
# Cloudflare Pages runs this and publishes the `dist/` directory. Set these two
# environment variables in the Pages project settings (Settings → Environment
# variables). Both are safe to expose in the browser:
#
#   SUPABASE_URL       https://<project-ref>.supabase.co
#   SUPABASE_ANON_KEY  the "anon / public" key from Project Settings → API
#
# NEVER add the service-role / secret key here. It would end up in a public
# JavaScript file and would let anyone rewrite every balance in the database.
# ---------------------------------------------------------------------------
set -euo pipefail

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_ANON_KEY:-}" ]; then
  echo "ERROR: SUPABASE_URL and SUPABASE_ANON_KEY must be set." >&2
  exit 1
fi

case "$SUPABASE_ANON_KEY" in
  *service_role*|sb_secret_*)
    echo "ERROR: that looks like a service-role key. Use the anon/public key." >&2
    exit 1 ;;
esac

rm -rf dist
mkdir -p dist
cp index.html app.js dist/

cat > dist/config.js <<EOF
/* Generated at build time. Contains only public, browser-safe values. */
window.CYBERPULSE_CONFIG = {
  SUPABASE_URL: "${SUPABASE_URL}",
  SUPABASE_ANON_KEY: "${SUPABASE_ANON_KEY}"
};
EOF

# Long-lived caching for the app shell is undesirable while iterating.
# X-Frame-Options stops the game being framed by a look-alike that could
# harvest credentials; the rest are cheap, standard hardening headers.
cat > dist/_headers <<'EOF'
/*
  Cache-Control: public, max-age=0, must-revalidate
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=()
  Cross-Origin-Opener-Policy: same-origin
EOF

# Pages serves index.html for unknown paths; the game is a single document, so
# this only matters if a player bookmarks a stale URL or refreshes mid-session.
cat > dist/_redirects <<'EOF'
/*    /index.html   200
EOF

echo "Built dist/ ($(ls dist | tr '\n' ' '))"

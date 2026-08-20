#!/usr/bin/env bash
# Starts Shitcord, checking everything first so failures explain themselves.
#   chmod +x start.sh
#   ./start.sh

cd "$(dirname "$0")" || exit 1
echo ""
echo "  Shitcord starter"
echo "  folder: $(pwd)"
echo ""

fail() { echo "  ✗ $1"; echo ""; exit 1; }

# ── 1. is Node installed? ────────────────────────────────────────
if ! command -v node > /dev/null 2>&1; then
  echo "  ✗ Node isn't installed."
  echo ""
  echo "    Install it with:"
  echo "      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "      sudo apt install -y nodejs"
  echo ""
  echo "    (Don't use 'sudo apt install nodejs' on its own — Raspberry Pi OS"
  echo "     ships a version too old for this.)"
  echo ""
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null)
echo "  ✓ node $(node -v)"
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  echo "  ✗ That's too old — this needs Node 18 or newer."
  echo ""
  echo "    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "    sudo apt install -y nodejs"
  echo ""
  exit 1
fi

# ── 2. are the files here? ───────────────────────────────────────
for f in server.js package.json index.html chat.html; do
  if [ ! -f "$f" ]; then
    echo "  ✗ Missing: $f"
    echo ""
    echo "    This folder holds:"
    ls -1 | grep -v '^node_modules$' | sed 's/^/      /'
    echo ""
    echo "    All four files need to be in the same folder as this script."
    echo "    Watch for downloads named 'chat (1).html' or 'server.js.txt'."
    echo ""
    exit 1
  fi
done
echo "  ✓ server.js, index.html, chat.html all present"

# ── 3. dependencies ──────────────────────────────────────────────
if [ ! -d node_modules ]; then
  echo "  … installing dependencies (first run only, can take a few minutes)"
  npm install || fail "npm install failed — scroll up for the reason."
  echo "  ✓ dependencies installed"
else
  echo "  ✓ dependencies already installed"
fi

# ── 4. is the port free? ─────────────────────────────────────────
PORT="${PORT:-8080}"
# server.js reports a busy port itself, so this is just a friendlier heads-up
if command -v ss > /dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  echo "  ! port $PORT looks busy — it may already be running"
fi

echo ""
exec node server.js

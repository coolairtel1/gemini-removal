#!/bin/zsh
# Double-click để chạy tool trên macOS
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund && npx playwright install chromium
fi
(sleep 1.5 && open "http://localhost:5178") &
node server.mjs

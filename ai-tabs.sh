#!/bin/bash
cd "$(dirname "$0")"

# Check if server already running on port 25283
if ! lsof -iTCP:25283 -sTCP:LISTEN -t >/dev/null 2>&1 && \
   ! ss -tlnp 2>/dev/null | grep -q ':25283 '; then
    nohup node server.js > /dev/null 2>&1 &
    sleep 2
fi

# Open browser (cross-platform)
if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:25283"
elif command -v open >/dev/null 2>&1; then
    open "http://localhost:25283"
else
    echo "ai-tabs running at http://localhost:25283"
fi

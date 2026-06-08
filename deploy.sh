#!/bin/bash
# AI-Todo deploy script - kills old server, starts new one, verifies
set -e
cd /Users/liliya/Desktop/AI-Todo

echo "=== Deploying AI-Todo ==="

# 1. Kill old server
OLD_PID=$(lsof -ti :8088 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
  kill $OLD_PID 2>/dev/null
  sleep 1
  echo "Killed old server (PID $OLD_PID)"
fi

# 2. Start new server
python3 -m http.server 8088 &
sleep 1
echo "Server started on :8088"

# 3. Verify
echo ""
echo "=== Verification ==="

# Check HTML
HTML=$(curl -s http://localhost:8088/)
echo -n "version badge: "; echo "$HTML" | grep -q 'v4[0-9]' && echo "✓ FOUND ($(echo "$HTML" | grep -o 'v4[0-9]' | head -1))" || echo "✗ MISSING"
echo -n "app.js versioned: "; echo "$HTML" | grep -q 'app.js?v=4[0-9]' && echo "✓ FOUND ($(echo "$HTML" | grep -o 'app.js?v=4[0-9]' | head -1))" || echo "✗ MISSING"
echo -n "full-screen (no max-width): "; echo "$HTML" | grep -q 'max-width: 480' && echo "✗ OLD LAYOUT" || echo "✓ CORRECT"
echo -n "no page-turn CSS: "; echo "$HTML" | grep -q 'view-perspective' && echo "✗ STILL PRESENT" || echo "✓ CLEAN"

# Check JS
JS=$(curl -s http://localhost:8088/app.js)
echo -n "SW disabled: "; echo "$JS" | grep -q 'DISABLED for development' && echo "✓ YES" || echo "✗ SW STILL ACTIVE"
echo -n "switchTab simple: "; echo "$JS" | grep -q 'function switchTab' && echo "✓ EXISTS" || echo "✗ MISSING"
echo -n "no page-turn refs: "; echo "$JS" | grep -q 'setupSwipe' && echo "✗ STILL PRESENT" || echo "✓ CLEAN"

echo ""
echo "=== Ready ==="
echo "Open: http://192.168.31.102:8088"
echo "Look for red version badge in top-right corner to confirm latest code."

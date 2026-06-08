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
echo -n "v41 badge: "; echo "$HTML" | grep -q 'v41' && echo "✓ FOUND" || echo "✗ MISSING"
echo -n "app.js?v=41: "; echo "$HTML" | grep -q 'app.js?v=41' && echo "✓ FOUND" || echo "✗ MISSING"
echo -n "full-screen (no max-width): "; echo "$HTML" | grep -q 'max-width: 480' && echo "✗ OLD LAYOUT" || echo "✓ CORRECT"
echo -n "opacity transition: "; echo "$HTML" | grep -q 'opacity 0.5s ease' && echo "✓ FOUND" || echo "✗ MISSING"

# Check JS
JS=$(curl -s http://localhost:8088/app.js)
echo -n "SW disabled: "; echo "$JS" | grep -q 'DISABLED for development' && echo "✓ YES" || echo "✗ SW STILL ACTIVE"
echo -n "COMPLETE_PCT=0.50: "; echo "$JS" | grep -q 'COMPLETE_PCT = 0.50' && echo "✓ YES" || echo "✗ NO"
echo -n "velocity logic: "; echo "$JS" | grep -q 'effectiveAngle' && echo "✓ YES" || echo "✗ NO"

echo ""
echo "=== Ready ==="
echo "Open: http://192.168.31.102:8088"
echo "Look for red 'v41' badge next to the title."
echo "Swipe should need 50%+ drag to flip (was 25%)."

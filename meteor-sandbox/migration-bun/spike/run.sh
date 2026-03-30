#!/bin/bash
# ESM Bundle Spike — Run & Validate
#
# Prerequisites:
#   1. A built Meteor app: meteor build /path/to/output --directory
#   2. npm install in /path/to/output/bundle/programs/server
#   3. MongoDB running (MONGO_URL)
#   4. Node.js 22+ and optionally Bun 1.2+
#   5. npm install ws (for DDP test client)
#
# Usage:
#   ./run.sh /path/to/output/bundle/programs/server [node|bun|both|test]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="${1:-}"
MODE="${2:-both}"

if [ -z "$SERVER_DIR" ]; then
  echo "Usage: ./run.sh <path-to-bundle/programs/server> [node|bun|both|test]"
  echo ""
  echo "Modes:"
  echo "  node  — Start with Node.js only"
  echo "  bun   — Start with Bun only (requires Bun)"
  echo "  both  — Start Node, test, then Bun, test"
  echo "  test  — Run full validation (Node + Bun + DDP + HTTP)"
  exit 1
fi

SERVER_DIR="$(cd "$SERVER_DIR" && pwd)"
export MONGO_URL="${MONGO_URL:-mongodb://localhost:27017/esm-spike}"
NODE_PORT="${PORT:-3000}"
BUN_PORT=$((NODE_PORT + 1))
export PORT="$NODE_PORT"

echo "=== ESM Bundle Spike ==="
echo "  Server dir: $SERVER_DIR"
echo "  MongoDB:    $MONGO_URL"
echo "  Node port:  $NODE_PORT"
echo "  Bun port:   $BUN_PORT (Bun.serve proxy)"
echo ""

cleanup() {
  [ -n "${NODE_PID:-}" ] && kill "$NODE_PID" 2>/dev/null || true
  [ -n "${BUN_PID:-}" ] && kill "$BUN_PID" 2>/dev/null || true
  wait 2>/dev/null
}
trap cleanup EXIT

run_node() {
  echo "--- Starting Node.js ---"
  ROOT_URL="http://localhost:$NODE_PORT" PORT=$NODE_PORT node "$SCRIPT_DIR/start-node.mjs" "$SERVER_DIR" &
  NODE_PID=$!
  sleep 5

  HTTP=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$NODE_PORT/" 2>/dev/null || echo "FAIL")
  if [ "$HTTP" = "200" ]; then
    echo "  ✅ Node HTTP: $HTTP"
  else
    echo "  ❌ Node HTTP: $HTTP"
    return 1
  fi
}

run_bun() {
  echo "--- Starting Bun ---"
  ROOT_URL="http://localhost:$BUN_PORT" PORT=$NODE_PORT bun "$SCRIPT_DIR/start-bun.mjs" "$SERVER_DIR" &
  BUN_PID=$!
  sleep 5

  HTTP=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$BUN_PORT/" 2>/dev/null || echo "FAIL")
  if [ "$HTTP" = "200" ]; then
    echo "  ✅ Bun HTTP: $HTTP"
  else
    echo "  ❌ Bun HTTP: $HTTP"
    return 1
  fi
}

test_ddp() {
  local PORT=$1
  local RUNTIME=$2
  echo "--- DDP test ($RUNTIME, port $PORT) ---"
  node "$SCRIPT_DIR/ddp-test.mjs" "ws://localhost:$PORT/websocket"
}

case "$MODE" in
  node)
    run_node
    echo ""
    echo "Server running. Press Ctrl+C to stop."
    wait
    ;;
  bun)
    run_bun
    echo ""
    echo "Server running. Press Ctrl+C to stop."
    wait
    ;;
  both)
    run_node
    test_ddp "$NODE_PORT" "Node"
    kill "$NODE_PID" 2>/dev/null; wait "$NODE_PID" 2>/dev/null; unset NODE_PID
    sleep 1
    echo ""
    run_bun
    test_ddp "$BUN_PORT" "Bun"
    kill "$BUN_PID" 2>/dev/null; wait "$BUN_PID" 2>/dev/null; unset BUN_PID
    echo ""
    echo "=== Both runtimes validated ==="
    ;;
  test)
    echo "=== Full validation ==="
    echo ""
    run_node
    test_ddp "$NODE_PORT" "Node"
    kill "$NODE_PID" 2>/dev/null; wait "$NODE_PID" 2>/dev/null; unset NODE_PID
    sleep 1
    echo ""
    if command -v bun &>/dev/null; then
      run_bun
      test_ddp "$BUN_PORT" "Bun"
      kill "$BUN_PID" 2>/dev/null; wait "$BUN_PID" 2>/dev/null; unset BUN_PID
    else
      echo "  ⏭️  Bun not installed, skipping"
    fi
    echo ""
    echo "=== Validation complete ==="
    ;;
esac

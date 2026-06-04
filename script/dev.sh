#!/usr/bin/env bash
set -euo pipefail

BACKEND_PORT="${1:-4096}"
FRONTEND_PORT="${2:-4444}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Starting Aether dev environment..."
echo "  Backend port:  $BACKEND_PORT"
echo "  Frontend port: $FRONTEND_PORT"
echo ""

cleanup() {
  echo "Shutting down..."
    kill "$BACKEND_PID" 2>/dev/null || true
    kill "$FRONTEND_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "Done."
}
trap cleanup EXIT INT TERM

bun run --cwd "$REPO_ROOT/packages/opencode" --conditions=browser ./src/index.ts serve --port "$BACKEND_PORT" &
BACKEND_PID=$!
echo "Backend PID: $BACKEND_PID  (http://localhost:$BACKEND_PORT)"

sleep 2

bun run --cwd "$REPO_ROOT/packages/app" dev -- --port "$FRONTEND_PORT" &
FRONTEND_PID=$!
echo "Frontend PID: $FRONTEND_PID (http://localhost:$FRONTEND_PORT)"

echo ""
echo "Open http://localhost:$FRONTEND_PORT in your browser."
echo "Press Ctrl+C to stop both servers."

wait
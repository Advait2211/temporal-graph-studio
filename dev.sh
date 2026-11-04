#!/usr/bin/env bash
# Runs the API (port 8000) and the UI (port 5173) together. Ctrl+C stops both.
set -e
cd "$(dirname "$0")"
(cd backend && uv sync -q && uv run uvicorn tcg.api:app --port 8000 --reload --reload-dir tcg) &
API=$!
trap 'kill $API 2>/dev/null' EXIT
cd frontend && ([ -d node_modules ] || npm install) && npx vite --port 5173

#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/histology-viewer-cop}"
BRANCH="${BRANCH:-main}"
SERVICE_NAME="${SERVICE_NAME:-histology-viewer}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4000/api/health}"

cd "$APP_DIR"

echo "Updating $APP_DIR from origin/$BRANCH"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

echo "Installing frontend dependencies"
npm ci

echo "Checking frontend"
npm run lint

echo "Building frontend"
npm run build

echo "Installing backend dependencies"
cd "$APP_DIR/server"
npm ci

echo "Testing backend logic"
npm test

echo "Restarting backend service"
sudo systemctl restart "$SERVICE_NAME"

echo "Checking backend health"
for attempt in {1..12}; do
  if curl -fsS "$HEALTH_URL" >/dev/null; then
    echo "Backend health check passed"
    break
  fi

  if [ "$attempt" -eq 12 ]; then
    echo "Backend health check failed: $HEALTH_URL"
    exit 1
  fi

  sleep 2
done

echo "Reloading nginx"
sudo systemctl reload nginx

echo "Deployment complete"

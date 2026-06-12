# Development workflow

## Branches

- `main` is the stable branch that is deployed to the server.
- New work should be done in a separate branch.

Create a branch:

```bash
git checkout main
git pull origin main
git checkout -b feature/change-name
```

## Local checks

Before pushing changes, run:

```bash
npm run lint
npm run build
```

For backend dependency changes:

```bash
cd server
npm ci
node --check server.js
```

## Commit and push

```bash
git status
git add .
git commit -m "Describe the change"
git push -u origin feature/change-name
```

Open a Pull Request on GitHub and merge it into `main` after CI passes.

## Deploy on the server

On the server:

```bash
cd /var/www/histology-viewer-cop
./scripts/deploy.sh
```

Before opening the site publicly, set admin auth variables for the backend
service:

```ini
Environment=ADMIN_PASSWORD=change-this-password
Environment=ADMIN_SESSION_SECRET=long-random-secret
```

After changing the systemd unit or override, run:

```bash
sudo systemctl daemon-reload
sudo systemctl restart histology-viewer
```

The deploy script:

1. Pulls the latest `main`.
2. Installs frontend dependencies.
3. Runs frontend linting.
4. Builds `dist`.
5. Installs backend dependencies.
6. Runs backend tests.
7. Restarts the `histology-viewer` service.
8. Checks `http://127.0.0.1:4000/api/health`.
9. Reloads Nginx.

After deployment, check the public site through Nginx:

```bash
curl https://your-domain.example/api/health
```

The response should have `"ok": true`, `"database": { "ok": true }`, and
`"adminAuth": { "configured": true }`. Slide counts should be non-zero if the
production database already contains materials.

Slide files are not stored in Git. Keep `public/slides` on the server and update it separately.

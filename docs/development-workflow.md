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

The deploy script:

1. Pulls the latest `main`.
2. Installs frontend dependencies.
3. Builds `dist`.
4. Installs backend dependencies.
5. Restarts the `histology-viewer` service.
6. Reloads Nginx.

Slide files are not stored in Git. Keep `public/slides` on the server and update it separately.

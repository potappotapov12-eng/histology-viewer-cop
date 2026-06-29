# Production readiness checklist

Use this checklist before treating the Histology Viewer installation as ready for real users.

## 1. Environment

- Copy `.env.production.example` to the server environment file, for example `/etc/histology-viewer.env`.
- Replace `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, database password, and every Moodle/LTI secret if LTI is enabled.
- Do not use temporary values such as `test123`, `change-me`, or `local-dev-secret`.
- Set `AUTH_MODE=local` and `ENABLE_MOODLE_LTI=false` for the direct local atlas.
- Set `AUTH_MODE=moodle_lti` and `ENABLE_MOODLE_LTI=true` only on a Moodle/LTI deployment.
- Confirm the real PostgreSQL port. On some machines the cluster may run on `5433` instead of `5432`.

## 2. Database and storage

- PostgreSQL is running and `DATABASE_URL` connects successfully.
- The `histology_viewer` database exists and is backed up.
- `raw-slides/`, `public/slides/`, `server/data/backups/`, and `server/data/upload-logs/` exist and are writable by the backend service user.
- Large slide files are included in a separate filesystem backup plan. Backend metadata backups do not replace slide-file backups.

## 3. Build and automated checks

Run from the repository root:

```bash
npm run preflight
```

This command runs:

- `npm run lint`
- `npm run build`
- `npm run test:server`

## 4. Service startup

Recommended runtime layout:

- backend: Node service running `npm --prefix server start`
- frontend: static files from `dist/` served by nginx or another web server
- reverse proxy routes `/api`, `/slides`, `/lti`, and `/.well-known` to `http://127.0.0.1:4000`
- all other routes serve the React app from `dist/`

After deployment, check:

```bash
curl -fsS http://127.0.0.1:4000/api/health
```

The response must return HTTP 200 and show healthy PostgreSQL/storage status.

## 5. Admin panel smoke test

Open `/admin` and verify:

- login works with `ADMIN_LOGIN` and `ADMIN_PASSWORD`;
- the `Пользователи` page opens;
- creating a local user works;
- editing role/status/permissions works;
- `Применить права по роли` resets individual permission overrides;
- blocking and activating a user works;
- password change works;
- users can log in with their assigned role;
- unauthorized users cannot open admin-only actions.

## 6. Content workflows

Verify with real or representative data:

- slide card creation and editing;
- ready DZI ZIP upload;
- slide conversion, if `vips/OpenSlide` is installed on the server;
- diagnostics creation and editing;
- diagnostic attempt submission;
- result review and grading;
- metadata backup creation and restore on a staging copy.

## 7. Security checks

- Temporary admin password was removed.
- `ADMIN_SESSION_SECRET` and `LTI_SESSION_SECRET` are long persistent random values.
- PostgreSQL is not exposed publicly unless explicitly protected.
- nginx/site uses HTTPS in real deployment.
- Real `.env` files and private keys are not committed.
- `DEV_AUTH_BYPASS=false` in production.

## 8. Final readiness decision

The project is ready for full work only after:

- `npm run preflight` passes;
- `/api/health` is healthy on the target server;
- the admin panel smoke test passes;
- at least one real slide, one diagnostic, and one test result workflow have been checked;
- backups for both metadata and slide files are configured.

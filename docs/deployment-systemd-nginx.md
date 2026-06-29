# Deployment with systemd and nginx

This is a reference deployment for one Linux server.

## 1. Build files

Repository path example:

```bash
/var/www/histology-viewer-cop
```

Install and build:

```bash
cd /var/www/histology-viewer-cop
npm ci
npm run build
cd server
npm ci --omit=dev
```

## 2. Environment file

Create `/etc/histology-viewer.env` from `.env.production.example` and replace secrets:

```ini
NODE_ENV=production
AUTH_MODE=local
ENABLE_MOODLE_LTI=false
PORT=4000
DATABASE_URL=postgres://histology_user:strong-password@127.0.0.1:5432/histology_viewer
ADMIN_LOGIN=admin
ADMIN_PASSWORD=strong-admin-password
ADMIN_SESSION_SECRET=long-random-secret
DEV_AUTH_BYPASS=false
```

Use the actual PostgreSQL port. Check it with:

```bash
pg_lsclusters
```

## 3. systemd service

Create `/etc/systemd/system/histology-viewer.service`:

```ini
[Unit]
Description=Histology Viewer API
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/var/www/histology-viewer-cop/server
EnvironmentFile=/etc/histology-viewer.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable histology-viewer
sudo systemctl restart histology-viewer
sudo systemctl status histology-viewer
```

## 4. nginx site

Create an nginx site such as `/etc/nginx/sites-available/histology-viewer`:

```nginx
server {
    listen 80;
    server_name atlas.example.edu;

    root /var/www/histology-viewer-cop/dist;
    index index.html;

    client_max_body_size 20G;

    location /api/ {
        proxy_pass http://127.0.0.1:4000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /slides/ {
        proxy_pass http://127.0.0.1:4000/slides/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /lti/ {
        proxy_pass http://127.0.0.1:4000/lti/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /.well-known/ {
        proxy_pass http://127.0.0.1:4000/.well-known/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/histology-viewer /etc/nginx/sites-enabled/histology-viewer
sudo nginx -t
sudo systemctl reload nginx
```

For production, add HTTPS with certbot or the server's standard TLS setup.

## 5. Health checks

```bash
curl -fsS http://127.0.0.1:4000/api/health
curl -fsS http://atlas.example.edu/api/health
```

Then open:

```text
https://atlas.example.edu/admin
```

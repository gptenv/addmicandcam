# Docker Notes

The root `Dockerfile` builds the full workspace, installs ffmpeg, espeak-ng, Playwright Chromium, and serves the compiled React app from the Fastify server.

Use:

```bash
docker compose up --build
```

The compose file is intended for local development.

For production-like deployments:

- Set `ALLOWED_URL_PATTERNS` / `BLOCKED_URL_PATTERNS` as needed
- Keep `ALLOW_PRIVATE_NETWORKS=false`
- Mount a persistent data volume at `APP_DATA_DIR`
- Put the service behind TLS and a reverse proxy if desired

(Note: the API is now public; `ADMIN_TOKEN` / `ALLOW_UNAUTHENTICATED_LOCAL` settings are no longer used.)

See the root README for **GCP Cloud Run** deployment (complete scaffolding including a one-command deploy script, Cloud Build config, declarative service.yaml, and resource tuning for Chromium workloads is included in the repo).

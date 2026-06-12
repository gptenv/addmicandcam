# Docker Notes

The root `Dockerfile` builds the full workspace, installs ffmpeg, espeak-ng, Playwright Chromium, and serves the compiled React app from the Fastify server.

Use:

```bash
docker compose up --build
```

The compose file is intended for local development. It sets `ALLOW_UNAUTHENTICATED_LOCAL=true`; change that before sharing the service beyond your machine.

For stricter deployments:

- Set a strong `ADMIN_TOKEN`
- Set `ALLOW_UNAUTHENTICATED_LOCAL=false`
- Set `ALLOWED_URL_PATTERNS`
- Keep `ALLOW_PRIVATE_NETWORKS=false`
- Mount a persistent data volume at `APP_DATA_DIR`
- Put the service behind TLS and an authenticated reverse proxy

See the root README for **GCP Cloud Run** deployment (complete scaffolding including a one-command deploy script, Cloud Build config, declarative service.yaml, Secret Manager integration, and resource tuning for Chromium workloads is included in the repo).

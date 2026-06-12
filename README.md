# LLM Telepresence Browser Lab

LLM Telepresence Browser Lab is a permissioned remote browser environment for authorized testing, demos, accessibility experiments, and user-owned video-chat labs. It gives LLM agents and browser tools a simple web UI plus HTTP/JSON API for creating isolated Chromium sessions, navigating pages, inspecting state, taking screenshots, and attaching synthetic camera or microphone sources.

## What This Is

- A Node.js, TypeScript, Fastify, Playwright, Vite, and React app.
- A browser-session controller designed for LLM-friendly operation.
- A fake camera lab using Chromium fake media devices and ffmpeg-generated Y4M files.
- A best-effort fake microphone lab using Chromium fake audio files, generated WAV assets, TTS, and documented host-level alternatives.
- A consent-first tool with visible generated-media disclosure support.

## What This Is Not

- Not a stealth, anti-detection, CAPTCHA bypass, credential theft, or platform-abuse tool.
- Not a way to impersonate people or enter conversations without permission.
- Not a guarantee that every WebRTC site will accept synthetic mic/camera sources.
- Not a replacement for OS-level virtual devices when live production audio/video routing is required.

Use it only on sites, accounts, rooms, meetings, and conversations where you have explicit permission to participate.

## Features

- Web UI at `/`
- Session UI at `/session/:id`
- Text-only agent page at `/lite`
- Human-readable API docs at `/api-docs`
- LLM-native JSON API under `/api`
- Asset upload for images, videos, and audio
- Image/video conversion to Chromium-compatible fake webcam Y4M
- Optional generated-video disclosure watermark
- TTS WAV generation through `espeak-ng` or `espeak` when installed
- Screenshot, page-state, console-log, and recent-error diagnostics
- URL allow/block patterns, private-network blocking, upload limits, session TTL, and max-session controls
- Docker and Docker Compose support

## Local Setup

Required:

- Node.js 22 or newer
- npm
- ffmpeg
- Playwright Chromium dependencies

Optional:

- `espeak-ng` or `espeak` for TTS
- `sox` for your own audio experiments
- PulseAudio/PipeWire or `v4l2loopback` for advanced host-level virtual devices

Install and build:

```bash
npm install
npm run build
npx playwright install chromium
cp .env.example .env
npm start
```

Open [http://localhost:3000](http://localhost:3000).

For development:

```bash
npm run dev
```

The API runs on port `3000`; Vite runs on port `5173` and proxies `/api` and `/lite`.

## Docker Setup

```bash
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). The compose file enables `ALLOW_UNAUTHENTICATED_LOCAL=true` for local testing. For shared or production deployments, set a strong `ADMIN_TOKEN` and set `ALLOW_UNAUTHENTICATED_LOCAL=false`.

## GCP Cloud Run Deployment

This app includes complete, production-oriented scaffolding to deploy as a GCP Cloud Run web service (single container serving the React UI + Fastify API on one port).

### One-command deploy (recommended)

The fully-working deploy script handles:

- API enablement, Artifact Registry repo creation
- Building the image (Cloud Build or local Docker)
- Creating/updating the Cloud Run service with **browser-friendly resources** (2 GiB memory, 2 CPU, low concurrency)
- Secret Manager integration for `ADMIN_TOKEN`
- Automatic `PUBLIC_BASE_URL` configuration after deploy (so session links are correct)
- Health verification + ready-to-run curl examples

```bash
# Interactive (will prompt for project / generate token if needed)
./scripts/deploy-gcp.sh

# Or fully non-interactive (CI / automation friendly)
PROJECT_ID=my-gcp-project \
REGION=us-central1 \
SERVICE=telepresence-lab \
ADMIN_TOKEN="$(openssl rand -hex 20)" \
./scripts/deploy-gcp.sh --non-interactive
```

The script is self-documenting and prints the live URL, token usage, and post-deploy hardening steps.

### Alternative: Cloud Build (declarative / Git-triggered)

```bash
# One-time repo setup (or let the deploy script create it)
gcloud artifacts repositories create telepresence-images --repository-format=docker --location=us-central1

gcloud builds submit \
  --config=cloudbuild.yaml \
  --substitutions="_REGION=us-central1,_SERVICE=telepresence-lab,_REPO=telepresence-images,_SECRET_NAME=telepresence-admin-token"
```

See [cloudbuild.yaml](cloudbuild.yaml) for details and Secret Manager wiring.

### Declarative service manifest

Edit [gcp/service.yaml](gcp/service.yaml) (update the image reference), then:

```bash
gcloud run services replace gcp/service.yaml --region=us-central1
# Follow up to set the real URL:
URL=$(gcloud run services describe telepresence-lab --format='value(status.url)' --region=us-central1)
gcloud run services update telepresence-lab --update-env-vars PUBLIC_BASE_URL=$URL --region=us-central1
```

### Important Cloud Run configuration (already wired in scaffolding)

- **Memory/CPU**: 2Gi + 2 vCPU (minimum realistic for Chromium + concurrent sessions; 512Mi will OOM).
- **Concurrency**: 1 (each active browser session is heavyweight; increase only if you cap MAX_SESSIONS very low).
- **Max instances**: 5 (tune together with `MAX_SESSIONS`).
- **Ephemeral storage**: `/data` (assets, Y4M/WAV files, derived media) is per-instance and lost on restarts/scale-to-zero. Fine for demos, testing, and short-lived labs. Persistent storage would require app-level Cloud Storage integration.
- **Secrets**: `ADMIN_TOKEN` stored in Secret Manager and mounted at runtime (preferred). The deploy script creates `telepresence-admin-token` secret and grants the Cloud Run runtime SA access.
- **Unauthenticated**: Initially allowed for easy testing. Production: `gcloud run services update ... --no-allow-unauthenticated` + IAM bindings.
- **PUBLIC_BASE_URL**: Automatically set by the deploy script to the canonical `https://...run.app` so `POST /api/sessions` returns usable absolute `web`/`lite`/etc. links.
- **Health**: `/api/health` is used implicitly; the server also responds to Cloud Run lifecycle signals.

### Post-deploy checklist

1. Visit the service URL and enter your admin token in the UI header.
2. Create a session and test a navigation + screenshot.
3. (Recommended) Lock down auth:
   ```bash
   gcloud run services update telepresence-lab --region=us-central1 --no-allow-unauthenticated
   gcloud run services add-iam-policy-binding telepresence-lab \
     --region=us-central1 \
     --member="user:your-email@example.com" \
     --role="roles/run.invoker"
   ```
4. Optionally set `ALLOWED_URL_PATTERNS` or other restrictions via env var updates.
5. Monitor logs: `gcloud run services logs read telepresence-lab --region=us-central1 --limit=100`

### Dockerfile & build notes for Cloud Run

The root [Dockerfile](Dockerfile) already produces a Cloud Run compatible image (Playwright installed with system deps at build time, dumb-init for signals, listens on `$PORT`).

Cloud Build + Artifact Registry is used because the image is large (Chromium) and benefits from remote caching / high-CPU builders.

## Security Configuration

Important environment variables:

- `ADMIN_TOKEN`: token accepted through `x-admin-token` or `Authorization: Bearer ...`
- `ALLOW_UNAUTHENTICATED_LOCAL`: disables API auth when `true`; use only for local development
- `MAX_SESSIONS`: concurrent session limit
- `SESSION_TTL_MS`: automatic session cleanup interval
- `UPLOAD_MAX_BYTES`: upload size limit
- `ALLOW_PRIVATE_NETWORKS`: allows localhost/private-network navigation when `true`
- `ALLOWED_URL_PATTERNS`: comma-separated glob patterns
- `BLOCKED_URL_PATTERNS`: comma-separated glob patterns
- `DISCLOSURE_WATERMARK_ENABLED`: adds disclosure text to generated camera video
- `DISCLOSURE_WATERMARK_LABEL`: default watermark label

Private, loopback, link-local, and reserved IP targets are blocked by default to reduce SSRF risk.

## Basic Workflow

Create a session:

```bash
curl -s -X POST http://localhost:3000/api/sessions \
  -H "content-type: application/json" \
  -H "x-admin-token: $TOKEN" \
  -d '{}'
```

Upload an avatar image:

```bash
curl -s -X POST http://localhost:3000/api/assets \
  -H "x-admin-token: $TOKEN" \
  -F "file=@avatar.png"
```

Set that image as the fake webcam:

```bash
curl -s -X POST http://localhost:3000/api/sessions/$SESSION/media/camera \
  -H "content-type: application/json" \
  -H "x-admin-token: $TOKEN" \
  -d '{"mode":"image","assetId":"ASSET_ID","disclosure":{"enabled":true,"label":"AI-assisted"}}'
```

Navigate to a target site:

```bash
curl -s -X POST http://localhost:3000/api/sessions/$SESSION/navigate \
  -H "content-type: application/json" \
  -H "x-admin-token: $TOKEN" \
  -d '{"url":"https://example.com"}'
```

Generate TTS audio:

```bash
curl -s -X POST http://localhost:3000/api/tts \
  -H "content-type: application/json" \
  -H "x-admin-token: $TOKEN" \
  -d '{"text":"Hello, I am testing audio.","voice":"default"}'
```

Inspect state:

```bash
curl -s http://localhost:3000/api/sessions/$SESSION/state \
  -H "x-admin-token: $TOKEN"
```

Take a screenshot:

```bash
curl -s http://localhost:3000/api/sessions/$SESSION/screenshot \
  -H "x-admin-token: $TOKEN"
```

## API Endpoints

- `POST /api/sessions`
- `GET /api/sessions`
- `GET /api/sessions/:id`
- `DELETE /api/sessions/:id`
- `POST /api/sessions/:id/navigate`
- `POST /api/sessions/:id/click`
- `POST /api/sessions/:id/type`
- `POST /api/sessions/:id/key`
- `POST /api/sessions/:id/evaluate`
- `POST /api/sessions/:id/reload`
- `POST /api/sessions/:id/back`
- `POST /api/sessions/:id/forward`
- `GET /api/sessions/:id/screenshot`
- `GET /api/sessions/:id/state`
- `GET /api/sessions/:id/stream`
- `POST /api/sessions/:id/media/camera`
- `POST /api/sessions/:id/media/mic`
- `GET /api/assets`
- `POST /api/assets`
- `GET /api/assets/:id/file`
- `POST /api/tts`

More examples are in [docs/api-examples.md](docs/api-examples.md).

## Known Limitations

- Chromium fake camera is the reliable path; uploaded images/videos are converted to Y4M and passed with `--use-file-for-fake-video-capture`.
- Changing fake camera or fake audio files requires relaunching that session’s Chromium instance. The app preserves the current URL, but in-page transient state may reset.
- Chromium fake mic support via `--use-file-for-fake-audio-capture` varies by platform and browser build.
- Cloud containers usually cannot expose kernel-level virtual camera or microphone devices.
- Cross-origin pages cannot be embedded as iframes, so this app uses screenshots and API actions instead of direct embedding.
- Some websites block automation or require real user verification/consent.
- Browser permissions and WebRTC behavior vary by site and Chromium version.

## Future Improvements

- Browserless/noVNC or WebRTC remote desktop streaming
- PipeWire/PulseAudio virtual microphone mode
- `v4l2loopback` host virtual camera integration
- More TTS adapters and voices
- Avatar animation and lip sync
- Stronger queueing/locking for concurrent agent actions

## Docs

- [Architecture](docs/architecture.md)
- [API examples](docs/api-examples.md)
- [Media limitations](docs/media-limitations.md)
- [Safety and consent](docs/safety.md)
- [Host virtual devices](docs/host-virtual-devices.md)

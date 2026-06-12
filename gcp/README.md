# GCP Cloud Run Deployment

This directory contains declarative configuration for deploying the LLM Telepresence Browser Lab to Google Cloud Run.

## Files

- `service.yaml` - Knative / Cloud Run service spec with production resource recommendations (2Gi memory, low concurrency, etc.).
- Use together with the root `cloudbuild.yaml` and `scripts/deploy-gcp.sh`.

## Quick usage

See the main project [README](../README.md#GCP-Cloud-Run-Deployment) for the recommended one-command deploy script and full instructions.

### Manual replace flow (example)

```bash
# 1. Build & push image first (Cloud Build recommended)
gcloud builds submit --config=../cloudbuild.yaml --substitutions=_REGION=us-central1

# 2. Update image reference in this file (or use :latest after push), then:
gcloud run services replace service.yaml --region=us-central1

# 3. Set the live PUBLIC_BASE_URL (critical for absolute links returned by the API)
URL=$(gcloud run services describe telepresence-lab --format='value(status.url)' --region=us-central1)
gcloud run services update telepresence-lab --update-env-vars PUBLIC_BASE_URL=$URL --region=us-central1
```

## Notes

- The API is public (authentication removed); `--allow-unauthenticated` is fine for most use cases.
- Consider IAM lockdown only if you want to restrict who can reach the service at the Cloud Run level.
- Consider setting `min-instances: 1` only if you need to avoid cold-start browser launch latency (costs more).
- Monitor memory/CPU; multiple concurrent browser sessions + ffmpeg transcodes are RAM + CPU intensive.

The app is designed as a single-container webapp; the Fastify server serves both the Vite-built React UI and the full JSON API + Lite UI.

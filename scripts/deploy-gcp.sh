#!/usr/bin/env bash
# scripts/deploy-gcp.sh
# Fully working, interactive-but-scriptable deploy helper for GCP Cloud Run.
#
# This script:
# - Validates gcloud + project
# - Enables required GCP APIs
# - Creates Artifact Registry Docker repo (if missing)
# - Builds the container image via Cloud Build (or local docker if you prefer)
# - Deploys to Cloud Run with production settings tuned for Playwright/Chromium (2Gi mem, low concurrency, etc.)
# - Captures the live service URL
# - Sets PUBLIC_BASE_URL so session links work correctly
# - Prints ready-to-use curl commands using the deployed URL + instructions for ADMIN_TOKEN
#
# Usage (recommended first time - interactive):
#   ./scripts/deploy-gcp.sh
#
# Non-interactive / CI:
#   PROJECT_ID=myproj REGION=us-central1 SERVICE=telepresence-lab \
#   ADMIN_TOKEN=super-secret-123 \
#   ./scripts/deploy-gcp.sh --non-interactive
#
# After deploy, visit the printed URL. Set the admin token in the web UI or via header.
# Data (uploads, generated media, sessions) is ephemeral per Cloud Run revision/instance.
# For multi-revision persistence you would need to integrate Cloud Storage.

set -euo pipefail

# ---------- Config (override via env or flags) ----------
PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-telepresence-lab}"
REPO="${REPO:-telepresence-images}"
IMAGE="${IMAGE:-telepresence-lab}"
MEMORY="${MEMORY:-2Gi}"
CPU="${CPU:-2}"
CONCURRENCY="${CONCURRENCY:-1}"
MAX_INSTANCES="${MAX_INSTANCES:-5}"
MIN_INSTANCES="${MIN_INSTANCES:-0}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
NON_INTERACTIVE=false
USE_CLOUD_BUILD=true   # set false to use local docker build + push (requires docker + auth)

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

log()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy] WARNING:${NC} $*"; }
err()  { echo -e "${RED}[deploy] ERROR:${NC} $*" >&2; }

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --project ID        GCP project (defaults to gcloud config)
  --region REGION     (default: us-central1)
  --service NAME      (default: telepresence-lab)
  --repo NAME         Artifact Registry repo name (default: telepresence-images)
  --admin-token T     Admin token value (will prompt/generate if omitted)
  --no-cloud-build    Build locally with docker instead of Cloud Build submit
  --non-interactive   Fail instead of prompting; all values must come from env/flags
  -h, --help
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT_ID="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --admin-token) ADMIN_TOKEN="$2"; shift 2 ;;
    --no-cloud-build) USE_CLOUD_BUILD=false; shift ;;
    --non-interactive) NON_INTERACTIVE=true; shift ;;
    -h|--help) usage ;;
    *) err "Unknown arg: $1"; usage ;;
  esac
done

# ---------- Prerequisites ----------
command -v gcloud >/dev/null 2>&1 || { err "gcloud CLI not found. Install Google Cloud SDK: https://cloud.google.com/sdk/docs/install"; exit 1; }

if [[ -z "$PROJECT_ID" ]]; then
  PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
fi
if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  if $NON_INTERACTIVE; then
    err "PROJECT_ID not set and gcloud has no default project. Set --project or run 'gcloud config set project ...'"
    exit 1
  fi
  read -rp "Enter GCP project ID: " PROJECT_ID
fi

log "Using project: $PROJECT_ID (region=$REGION, service=$SERVICE)"

gcloud config set project "$PROJECT_ID" >/dev/null

# Enable APIs (idempotent)
log "Enabling required APIs (cloudbuild, run, artifactregistry, secretmanager)..."
gcloud services enable \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  --project "$PROJECT_ID" --quiet

# ---------- Artifact Registry repo ----------
AR_HOST="${REGION}-docker.pkg.dev"
IMAGE_PATH="${AR_HOST}/${PROJECT_ID}/${REPO}/${IMAGE}"

if ! gcloud artifacts repositories describe "$REPO" --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  log "Creating Artifact Registry Docker repository: $REPO in $REGION"
  gcloud artifacts repositories create "$REPO" \
    --repository-format=docker \
    --location="$REGION" \
    --project="$PROJECT_ID" \
    --description="LLM Telepresence Browser Lab container images" \
    --quiet || true
fi

# ---------- Admin token handling ----------
if [[ -z "$ADMIN_TOKEN" ]]; then
  if $NON_INTERACTIVE; then
    ADMIN_TOKEN="gcp-$(openssl rand -hex 16 2>/dev/null || date +%s | shasum | head -c 32)"
    warn "No ADMIN_TOKEN provided in non-interactive mode. Generated one (store it!): $ADMIN_TOKEN"
  else
    echo
    echo "A strong ADMIN_TOKEN is required to protect the /api and /lite endpoints in production."
    read -rp "Enter admin token (or press Enter to auto-generate a strong one): " ADMIN_TOKEN
    if [[ -z "$ADMIN_TOKEN" ]]; then
      ADMIN_TOKEN="gcp-$(openssl rand -hex 18 2>/dev/null || python3 -c 'import secrets; print(secrets.token_hex(18))' 2>/dev/null || date +%s%N | sha256sum | head -c 36)"
      log "Generated admin token: $ADMIN_TOKEN"
      warn "Save this token now - it will be required for all API calls after deployment!"
    fi
  fi
fi

# Store token in Secret Manager (best practice) - create or update
SECRET_NAME="telepresence-admin-token"
if gcloud secrets describe "$SECRET_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
  log "Updating existing Secret Manager secret: $SECRET_NAME"
  printf '%s' "$ADMIN_TOKEN" | gcloud secrets versions add "$SECRET_NAME" --data-file=- --project="$PROJECT_ID" --quiet
else
  log "Creating Secret Manager secret: $SECRET_NAME"
  printf '%s' "$ADMIN_TOKEN" | gcloud secrets create "$SECRET_NAME" --data-file=- --project="$PROJECT_ID" --quiet
fi

# Grant Cloud Run SA access to the secret (least-privilege)
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
RUN_SA="service-${PROJECT_NUMBER}@serverless-robot-prod.iam.gserviceaccount.com"
log "Granting Secret Manager secretAccessor to Cloud Run service account..."
gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
  --member="serviceAccount:${RUN_SA}" \
  --role="roles/secretmanager.secretAccessor" \
  --project="$PROJECT_ID" --quiet 2>/dev/null || true

# ---------- Build the image ----------
SHORT_SHA="$(date +%Y%m%d%H%M%S)-$(head -c 8 /dev/urandom | xxd -p 2>/dev/null || echo local)"
IMAGE_TAG="${IMAGE_PATH}:${SHORT_SHA}"
IMAGE_LATEST="${IMAGE_PATH}:latest"

if $USE_CLOUD_BUILD; then
  log "Submitting build to Cloud Build (this uploads source + builds the image with Playwright inside)..."
  # We use a targeted cloudbuild that also does the deploy step, but here we just want the image first
  # so we can do a controlled deploy + post-configure PUBLIC_BASE_URL.
  gcloud builds submit . \
    --config=cloudbuild.yaml \
    --substitutions="_REGION=${REGION},_SERVICE=${SERVICE},_REPO=${REPO},_IMAGE=${IMAGE},_SECRET_NAME=${SECRET_NAME}" \
    --project="$PROJECT_ID" \
    --timeout=25m \
    --quiet

  # Cloud Build already did a deploy, but we will do a follow-up update for PUBLIC_BASE_URL + ensure latest settings.
  # Re-tag in mind as the yaml pushed :latest and :$SHORT_SHA from inside.
  # For the script we still want to know the exact deployed URL, so we continue to the deploy/update phase.
else
  log "Building locally with docker (requires local Docker + gcloud auth)..."
  docker build -t "$IMAGE_TAG" -t "$IMAGE_LATEST" .
  log "Pushing image to Artifact Registry..."
  gcloud auth configure-docker "$AR_HOST" --quiet
  docker push "$IMAGE_TAG"
  docker push "$IMAGE_LATEST"
fi

# ---------- Deploy / Update Cloud Run service ----------
log "Deploying / updating Cloud Run service: $SERVICE"

# Base common args
DEPLOY_ARGS=(
  --image "$IMAGE_LATEST"
  --region "$REGION"
  --platform managed
  --memory "$MEMORY"
  --cpu "$CPU"
  --concurrency "$CONCURRENCY"
  --max-instances "$MAX_INSTANCES"
  --min-instances "$MIN_INSTANCES"
  --port 3000
  --timeout 900s
  --set-env-vars "NODE_ENV=production,HEADLESS=true,HOST=0.0.0.0,PORT=3000,APP_DATA_DIR=/data,ALLOW_UNAUTHENTICATED_LOCAL=false,MAX_SESSIONS=4,SESSION_TTL_MS=3600000,UPLOAD_MAX_BYTES=52428800,ALLOW_PRIVATE_NETWORKS=false,DISCLOSURE_WATERMARK_ENABLED=true,DISCLOSURE_WATERMARK_LABEL=AI-assisted"
  --update-secrets "ADMIN_TOKEN=${SECRET_NAME}:latest"
  --project "$PROJECT_ID"
  --quiet
)

# First deploy or update (create allows unauth for demo convenience; lock down later)
if gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  log "Service exists - updating..."
  gcloud run services update "$SERVICE" "${DEPLOY_ARGS[@]}"
else
  log "Creating new service (initially allowing unauthenticated traffic for easy testing)..."
  gcloud run services create "$SERVICE" "${DEPLOY_ARGS[@]}" --allow-unauthenticated
fi

# ---------- Capture live URL and set PUBLIC_BASE_URL ----------
log "Retrieving deployed service URL..."
SERVICE_URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')"

if [[ -z "$SERVICE_URL" ]]; then
  err "Failed to retrieve service URL"
  exit 1
fi

log "Setting PUBLIC_BASE_URL=${SERVICE_URL} (so created sessions return correct absolute links)"
gcloud run services update "$SERVICE" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --update-env-vars "PUBLIC_BASE_URL=${SERVICE_URL}" \
  --quiet

# ---------- Health check & final output ----------
log "Waiting a few seconds for revision to be ready..."
sleep 6

log "Calling health endpoint to verify..."
HEALTH=$(curl -sS --max-time 15 "${SERVICE_URL}/api/health" || echo '{"status":"unreachable"}')
echo "$HEALTH" | head -c 500; echo

echo
echo "======================================================================"
echo -e "${GREEN}DEPLOYMENT COMPLETE${NC}"
echo "======================================================================"
echo
echo "Service URL:           ${SERVICE_URL}"
echo "Admin token (secret):  ${ADMIN_TOKEN}   (stored in Secret Manager: ${SECRET_NAME})"
echo
echo "Web UI:                ${SERVICE_URL}/"
echo "Lite UI:               ${SERVICE_URL}/lite"
echo "API docs:              ${SERVICE_URL}/api-docs"
echo "Health:                ${SERVICE_URL}/api/health"
echo
echo "Example curl (create session):"
echo "  curl -s -X POST ${SERVICE_URL}/api/sessions \\"
echo "    -H 'content-type: application/json' \\"
echo "    -H \"x-admin-token: ${ADMIN_TOKEN}\" \\"
echo "    -d '{}'"
echo
echo "To use the web UI, open ${SERVICE_URL} and paste the admin token into the 'Admin token' field."
echo
warn "SECURITY: This initial deploy allows unauthenticated HTTP traffic."
echo "          To lock it down for production:"
echo "            gcloud run services update ${SERVICE} --region=${REGION} --no-allow-unauthenticated"
echo "            gcloud run services add-iam-policy-binding ${SERVICE} --region=${REGION} --member='user:you@example.com' --role='roles/run.invoker'"
echo
warn "DATA PERSISTENCE: /data (assets, generated Y4M/WAV, screenshots) lives only on the ephemeral instance disk."
echo "          Sessions are lost on scale-to-zero / new revision. This is acceptable for a lab tool."
echo "          For production persistence, extend the app to use Cloud Storage for assets."
echo
log "To redeploy after code changes: just re-run this script (it re-uses the same service name)."
echo
echo "Tip: pin a specific revision or use traffic splitting with 'gcloud run services update-traffic'."
echo "======================================================================"

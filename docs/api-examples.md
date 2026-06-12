# API Examples

The API is public (no authentication required).

```bash
export BASE=http://localhost:3000

# Health & capabilities
curl -s "$BASE/api/health" | jq

# Create session
SESSION=$(curl -s -X POST "$BASE/api/sessions" \
  -H 'content-type: application/json' \
  -d '{}' | jq -r '.data.session.id')

# List sessions
curl -s "$BASE/api/sessions" | jq

# Get session status
curl -s "$BASE/api/sessions/$SESSION" | jq

# Navigate
curl -s -X POST "$BASE/api/sessions/$SESSION/navigate" \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}' | jq

# Upload asset (image, video or audio)
ASSET=$(curl -s -X POST "$BASE/api/assets" -F 'file=@avatar.png' | jq -r '.data.id')

# Set camera from asset (or use "test-pattern")
curl -s -X POST "$BASE/api/sessions/$SESSION/media/camera" \
  -H 'content-type: application/json' \
  -d '{"mode":"image","assetId":"'"$ASSET"'","disclosure":{"enabled":true,"label":"AI-assisted"}}' | jq

# Set mic (silence, tts, or audio-file)
curl -s -X POST "$BASE/api/sessions/$SESSION/media/mic" \
  -H 'content-type: application/json' \
  -d '{"mode":"tts","text":"Hello, this is a synthetic microphone.","voice":"default"}' | jq

# Click / Type / Key
curl -s -X POST "$BASE/api/sessions/$SESSION/click" \
  -H 'content-type: application/json' \
  -d '{"selector":"button"}' | jq

curl -s -X POST "$BASE/api/sessions/$SESSION/type" \
  -H 'content-type: application/json' \
  -d '{"selector":"input, textarea","text":"hello world"}' | jq

curl -s -X POST "$BASE/api/sessions/$SESSION/key" \
  -H 'content-type: application/json' \
  -d '{"key":"Enter"}' | jq

# Evaluate JS in page
curl -s -X POST "$BASE/api/sessions/$SESSION/evaluate" \
  -H 'content-type: application/json' \
  -d '{"script":"document.title"}' | jq

# Screenshot (data URL or raw PNG)
curl -s "$BASE/api/sessions/$SESSION/screenshot" | jq -r '.data.dataUrl'
curl -s "$BASE/api/sessions/$SESSION/screenshot?format=png" > shot.png

# Rich page state (elements, visible text, logs, media status, etc.)
curl -s "$BASE/api/sessions/$SESSION/state" | jq

# SSE screenshot stream
curl -N "$BASE/api/sessions/$SESSION/stream"

# Generate TTS asset
curl -s -X POST "$BASE/api/tts" \
  -H 'content-type: application/json' \
  -d '{"text":"This audio can be used as a microphone source.","voice":"default"}' | jq

# Close session
curl -s -X DELETE "$BASE/api/sessions/$SESSION" | jq
```

## LLM Agent Loop (recommended pattern)

1. `POST /api/sessions` (optionally with `initialUrl`)
2. `POST /api/assets` for any images/videos/audio you want to inject
3. `POST /api/sessions/:id/media/camera` and/or `/media/mic`
4. `POST /api/sessions/:id/navigate`
5. Loop using `GET /state` (or `/screenshot`) to observe, then `POST /click`, `/type`, `/key`, `/navigate`, `/evaluate`, etc.
6. `DELETE /api/sessions/:id` when done

All endpoints are documented in the in-app page at `/api-docs` (served by the React frontend) and in the project README.

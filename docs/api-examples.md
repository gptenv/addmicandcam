# API Examples

The API is public (no token required).

```bash
export BASE=http://localhost:3000
```

Create a session:

```bash
curl -s -X POST "$BASE/api/sessions" \
  -H "content-type: application/json" \
  -d '{}'
```

Navigate:

```bash
curl -s -X POST "$BASE/api/sessions/SESSION_ID/navigate" \
  -H "content-type: application/json" \
  -d '{"url":"https://example.com"}'
```

Upload an avatar image:

```bash
curl -s -X POST "$BASE/api/assets" \
  -F "file=@avatar.png"
```

Set the fake camera:

```bash
curl -s -X POST "$BASE/api/sessions/SESSION_ID/media/camera" \
  -H "content-type: application/json" \
  -d '{"mode":"image","assetId":"ASSET_ID","disclosure":{"enabled":true,"label":"AI-assisted"}}'
```

Generate TTS:

```bash
curl -s -X POST "$BASE/api/tts" \
  -H "content-type: application/json" \
  -d '{"text":"Hello, I am testing audio.","voice":"default"}'
```

Inspect page state:

```bash
curl -s "$BASE/api/sessions/SESSION_ID/state"
```

LLM agent workflow:

1. `POST /api/sessions`
2. `POST /api/assets` with an approved avatar image
3. `POST /api/sessions/:id/media/camera`
4. `POST /api/sessions/:id/navigate`
5. Use `/state`, `/screenshot`, `/click`, `/type`, and `/key` in a loop
6. `DELETE /api/sessions/:id`

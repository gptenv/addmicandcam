# API Examples

Set a token when auth is enabled:

```bash
export BASE=http://localhost:3000
export TOKEN=dev-token-change-me
```

Create a session:

```bash
curl -s -X POST "$BASE/api/sessions" \
  -H "content-type: application/json" \
  -H "x-admin-token: $TOKEN" \
  -d '{}'
```

Navigate:

```bash
curl -s -X POST "$BASE/api/sessions/SESSION_ID/navigate" \
  -H "content-type: application/json" \
  -H "x-admin-token: $TOKEN" \
  -d '{"url":"https://example.com"}'
```

Upload an avatar image:

```bash
curl -s -X POST "$BASE/api/assets" \
  -H "x-admin-token: $TOKEN" \
  -F "file=@avatar.png"
```

Set the fake camera:

```bash
curl -s -X POST "$BASE/api/sessions/SESSION_ID/media/camera" \
  -H "content-type: application/json" \
  -H "x-admin-token: $TOKEN" \
  -d '{"mode":"image","assetId":"ASSET_ID","disclosure":{"enabled":true,"label":"AI-assisted"}}'
```

Generate TTS:

```bash
curl -s -X POST "$BASE/api/tts" \
  -H "content-type: application/json" \
  -H "x-admin-token: $TOKEN" \
  -d '{"text":"Hello, I am testing audio.","voice":"default"}'
```

Inspect page state:

```bash
curl -s "$BASE/api/sessions/SESSION_ID/state" \
  -H "x-admin-token: $TOKEN"
```

LLM agent workflow:

1. `POST /api/sessions`
2. `POST /api/assets` with an approved avatar image
3. `POST /api/sessions/:id/media/camera`
4. `POST /api/sessions/:id/navigate`
5. Use `/state`, `/screenshot`, `/click`, `/type`, and `/key` in a loop
6. `DELETE /api/sessions/:id`

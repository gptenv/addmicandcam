# Architecture

The repository is an npm workspace:

- `apps/server`: Fastify API (public, no auth), Playwright session manager, uploads, URL policy, static frontend serving
- `apps/web`: Vite React control UI
- `packages/shared`: shared TypeScript API/session/asset types
- `packages/media`: ffmpeg and espeak wrappers for generated media
- `docs`: operator and API documentation
- `docker`: deployment notes

Session lifecycle:

1. `POST /api/sessions` creates a managed session record and launches isolated Chromium.
2. Actions such as navigate, click, type, key, evaluate, screenshot, and state operate on the Playwright page.
3. Camera or mic source changes update the session media config and relaunch Chromium with the relevant fake-media flags.
4. A TTL cleanup loop closes expired sessions and browser processes.

Synthetic camera path:

1. Upload image or video through `POST /api/assets`.
2. `POST /api/sessions/:id/media/camera` converts the asset to Y4M with ffmpeg.
3. Optional disclosure text is burned into the generated video with ffmpeg `drawtext`.
4. Chromium is relaunched with `--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`, and `--use-file-for-fake-video-capture`.

Synthetic mic path:

1. Uploaded audio is normalized to mono 48 kHz WAV, or TTS generates a WAV through espeak.
2. Chromium is relaunched with `--use-file-for-fake-audio-capture`.
3. Silence mode also installs a Web Audio `getUserMedia` fallback for pages that call the standard API.
4. Host-level virtual microphone routing remains an operator-managed advanced mode.

Security boundaries:

- The API is public (authentication has been removed).
- Uploads are stored under `APP_DATA_DIR`; arbitrary filesystem paths are not accepted.
- URL navigation is limited to `http` and `https`.
- Local/private/reserved networks are blocked by default.
- Allowlist and blocklist patterns can further constrain navigation.

Interactive viewport passthrough (added for Agent Mode compatibility):

- On `/session/:id` the "Remote Browser View" is now a live, focusable screenshot surface driven by the existing `/api/sessions/:id/stream` SSE endpoint.
- User (or agent) clicks, wheels, and keypresses are captured on the rendered screenshot image.
- Coordinates are scaled from CSS-display size to the screenshot's natural dimensions (Playwright viewport, typically 1280x720) and sent via new POST `/api/sessions/:id/input/*` endpoints (click, move, wheel, type, key).
- Backend uses `page.mouse.click(x, y)`, `page.mouse.wheel(...)`, `page.keyboard.type(...)` / `press(...)` directly on the Playwright page.
- This is screenshot-driven (not live DOM iframe embedding) so it is cross-origin safe and works with the existing synthetic-media and policy layers.
- Limitations: latency of screenshot roundtrip, no direct DOM hit-testing from client (use /state for that), wheel/click position is "last known mouse" for some ops. Selector-based actions remain available for precision.

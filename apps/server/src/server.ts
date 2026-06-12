import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import type { ApiResult, CreateSessionResponse } from "@telepresence/shared";
import { probeMediaTools, synthesizeSpeechWithEspeak } from "@telepresence/media";
import { createReadStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import { AssetStore } from "./assetStore.js";
import { getRequestToken, isAuthorized } from "./auth.js";
import { HttpError } from "./errors.js";
import { mapExternalToolError, SessionManager } from "./sessionManager.js";

export async function createServer(config: AppConfig) {
  await mkdir(config.dataDir, { recursive: true });
  const assets = new AssetStore(config.dataDir);
  await assets.init();
  const sessions = new SessionManager(config, assets);
  sessions.startCleanupLoop();

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info"
    },
    bodyLimit: Math.max(config.uploadMaxBytes, 1024 * 1024)
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(formbody);
  await app.register(multipart, {
    limits: {
      files: 1,
      fileSize: config.uploadMaxBytes
    }
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api") || request.url === "/api/health") {
      return;
    }
    if (!isAuthorized(config, request)) {
      return reply.code(401).send(
        errorResult("UNAUTHORIZED", "API calls require x-admin-token or Authorization: Bearer token")
      );
    }
  });

  app.setErrorHandler(async (error, _request, reply) => {
    const mapped = mapExternalToolError(error) ?? (error instanceof HttpError ? error : undefined);
    if (mapped) {
      await reply.code(mapped.statusCode).send(errorResult(mapped.code, mapped.message, mapped.details));
      return;
    }
    app.log.error(error);
    const message = error instanceof Error ? error.message : "Unexpected server error";
    await reply.code(500).send(errorResult("INTERNAL_ERROR", message));
  });

  app.addHook("onClose", async () => {
    await sessions.closeAll();
  });

  app.get("/api/health", async () => {
    return okResult("state", {
      status: "ok",
      mediaTools: await probeMediaTools(),
      authRequired: !config.allowUnauthenticatedLocal,
      maxSessions: config.maxSessions
    });
  });

  app.post("/api/sessions", async (request) => {
    const body = request.body as { initialUrl?: string } | undefined;
    const session = await sessions.createSession(body?.initialUrl);
    return okResult<CreateSessionResponse>("created", {
      session,
      urls: sessionUrls(config.baseUrl, session.id)
    });
  });

  app.get("/api/sessions", async () => {
    return okResult("state", sessions.listSessions());
  });

  app.get("/api/sessions/:id", async (request) => {
    const { id } = request.params as { id: string };
    return okResult("state", sessions.getStatus(id));
  });

  app.delete("/api/sessions/:id", async (request) => {
    const { id } = request.params as { id: string };
    await sessions.deleteSession(id);
    return okResult("closed", { id });
  });

  app.post("/api/sessions/:id/navigate", async (request) => {
    const { id } = request.params as { id: string };
    const body = requireBody<{ url?: string }>(request);
    if (!body.url) {
      throw new HttpError(400, "URL_REQUIRED", "Body must include url");
    }
    return okResult("navigated", await sessions.navigate(id, body.url));
  });

  app.post("/api/sessions/:id/click", async (request) => {
    const { id } = request.params as { id: string };
    const body = requireBody<{ selector?: string }>(request);
    if (!body.selector) {
      throw new HttpError(400, "SELECTOR_REQUIRED", "Body must include selector");
    }
    return okResult("clicked", await sessions.click(id, body.selector));
  });

  app.post("/api/sessions/:id/type", async (request) => {
    const { id } = request.params as { id: string };
    const body = requireBody<{ selector?: string; text?: string }>(request);
    if (!body.selector) {
      throw new HttpError(400, "SELECTOR_REQUIRED", "Body must include selector");
    }
    return okResult("typed", await sessions.type(id, body.selector, body.text ?? ""));
  });

  app.post("/api/sessions/:id/key", async (request) => {
    const { id } = request.params as { id: string };
    const body = requireBody<{ key?: string }>(request);
    if (!body.key) {
      throw new HttpError(400, "KEY_REQUIRED", "Body must include key");
    }
    return okResult("key-pressed", await sessions.pressKey(id, body.key));
  });

  app.post("/api/sessions/:id/evaluate", async (request) => {
    const { id } = request.params as { id: string };
    const body = requireBody<{ script?: string }>(request);
    if (!body.script) {
      throw new HttpError(400, "SCRIPT_REQUIRED", "Body must include script");
    }
    return okResult("evaluated", await sessions.evaluate(id, body.script));
  });

  app.post("/api/sessions/:id/reload", async (request) => {
    const { id } = request.params as { id: string };
    return okResult("navigated", await sessions.reload(id));
  });

  app.post("/api/sessions/:id/back", async (request) => {
    const { id } = request.params as { id: string };
    return okResult("navigated", await sessions.back(id));
  });

  app.post("/api/sessions/:id/forward", async (request) => {
    const { id } = request.params as { id: string };
    return okResult("navigated", await sessions.forward(id));
  });

  app.get("/api/sessions/:id/screenshot", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { format?: string } | undefined;
    const dataUrl = await sessions.screenshot(id);
    if (query?.format === "png") {
      const base64 = dataUrl.split(",")[1] ?? "";
      return reply.type("image/png").send(Buffer.from(base64, "base64"));
    }
    return okResult("screenshot", { dataUrl });
  });

  app.get("/api/sessions/:id/state", async (request) => {
    const { id } = request.params as { id: string };
    return okResult("state", await sessions.pageState(id));
  });

  app.post("/api/sessions/:id/media/camera", async (request) => {
    const { id } = request.params as { id: string };
    return okResult("media-updated", await sessions.setCameraSource(id, requireBody(request)));
  });

  app.post("/api/sessions/:id/media/mic", async (request) => {
    const { id } = request.params as { id: string };
    return okResult("media-updated", await sessions.setMicSource(id, requireBody(request)));
  });

  app.get("/api/sessions/:id/stream", async (request, reply) => {
    const { id } = request.params as { id: string };
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    });
    const send = async () => {
      try {
        const dataUrl = await sessions.screenshot(id);
        reply.raw.write(`event: screenshot\ndata: ${JSON.stringify({ dataUrl, status: sessions.getStatus(id) })}\n\n`);
      } catch (error) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`);
      }
    };
    await send();
    const timer = setInterval(() => void send(), 3000);
    request.raw.on("close", () => clearInterval(timer));
  });

  app.get("/api/assets", async () => {
    return okResult("state", assets.list());
  });

  app.post("/api/assets", async (request) => {
    const upload = await request.file();
    if (!upload) {
      throw new HttpError(400, "FILE_REQUIRED", "Multipart request must include a file field");
    }
    return okResult("created", await assets.createFromUpload(upload));
  });

  app.get("/api/assets/:id/file", async (request, reply) => {
    const { id } = request.params as { id: string };
    const asset = assets.get(id);
    if (!asset) {
      throw new HttpError(404, "ASSET_NOT_FOUND", `No asset with id ${id}`);
    }
    return reply.type(asset.mimeType).send(assets.createReadStream(id));
  });

  app.post("/api/tts", async (request) => {
    const body = requireBody<{ text?: string; voice?: string }>(request);
    if (!body.text?.trim()) {
      throw new HttpError(400, "TTS_TEXT_REQUIRED", "Body must include text");
    }
    const reserved = assets.reserveGeneratedPath("wav");
    await synthesizeSpeechWithEspeak({ text: body.text, voice: body.voice, outputPath: reserved.filePath });
    const asset = await assets.registerGeneratedAsset({
      id: reserved.id,
      filePath: reserved.filePath,
      kind: "audio",
      mimeType: "audio/wav",
      originalName: "tts.wav"
    });
    return okResult("created", asset);
  });

  app.get("/lite", async (request, reply) => {
    return reply.type("text/html").send(renderLitePage(config, request, sessions));
  });

  app.post("/lite/create", async (request, reply) => {
    ensureLiteAuth(config, request);
    const body = request.body as { token?: string; initialUrl?: string } | undefined;
    const session = await sessions.createSession(body?.initialUrl || undefined);
    return reply.redirect(`/lite?session=${encodeURIComponent(session.id)}&token=${encodeURIComponent(String(body?.token ?? ""))}`);
  });

  app.post("/lite/navigate", async (request, reply) => {
    ensureLiteAuth(config, request);
    const body = request.body as { token?: string; session?: string; url?: string } | undefined;
    if (!body?.session || !body.url) {
      throw new HttpError(400, "FORM_REQUIRED", "session and url are required");
    }
    await sessions.navigate(body.session, body.url);
    return reply.redirect(`/lite?session=${encodeURIComponent(body.session)}&token=${encodeURIComponent(String(body.token ?? ""))}`);
  });

  app.post("/lite/action", async (request, reply) => {
    ensureLiteAuth(config, request);
    const body = request.body as {
      token?: string;
      session?: string;
      action?: string;
      selector?: string;
      text?: string;
      key?: string;
    } | undefined;
    if (!body?.session) {
      throw new HttpError(400, "SESSION_REQUIRED", "session is required");
    }
    if (body.action === "click" && body.selector) {
      await sessions.click(body.session, body.selector);
    } else if (body.action === "type" && body.selector) {
      await sessions.type(body.session, body.selector, body.text ?? "");
    } else if (body.action === "key" && body.key) {
      await sessions.pressKey(body.session, body.key);
    } else if (body.action === "screenshot") {
      await sessions.screenshot(body.session);
    } else {
      throw new HttpError(400, "INVALID_ACTION", "Unsupported lite action");
    }
    return reply.redirect(`/lite?session=${encodeURIComponent(body.session)}&token=${encodeURIComponent(String(body.token ?? ""))}`);
  });

  await registerFrontend(app, config);
  return app;
}

function okResult<T>(action: ApiResult<T>["action"], data: T): ApiResult<T> {
  return { ok: true, action, data };
}

function errorResult(code: string, message: string, details?: unknown): ApiResult {
  return { ok: false, error: { code, message, details } };
}

function requireBody<T>(request: FastifyRequest): T {
  if (!request.body || typeof request.body !== "object") {
    throw new HttpError(400, "BODY_REQUIRED", "Request body must be a JSON object");
  }
  return request.body as T;
}

function sessionUrls(baseUrl: string, id: string): CreateSessionResponse["urls"] {
  return {
    web: `${baseUrl}/session/${id}`,
    lite: `${baseUrl}/lite?session=${id}`,
    api: `${baseUrl}/api/sessions/${id}`,
    screenshot: `${baseUrl}/api/sessions/${id}/screenshot`,
    state: `${baseUrl}/api/sessions/${id}/state`
  };
}

function ensureLiteAuth(config: AppConfig, request: FastifyRequest): void {
  const body = request.body as { token?: unknown } | undefined;
  if (!isAuthorized(config, request, body?.token)) {
    throw new HttpError(401, "UNAUTHORIZED", "Lite actions require a valid token");
  }
}

function renderLitePage(config: AppConfig, request: FastifyRequest, sessions: SessionManager): string {
  const query = request.query as { session?: string; token?: string } | undefined;
  const token = query?.token ?? getRequestToken(request) ?? "";
  const selectedId = query?.session ?? sessions.listSessions()[0]?.id ?? "";
  const selectedStatus = selectedId ? safeStatus(sessions, selectedId) : undefined;
  const screenshot = selectedStatus?.latestScreenshotDataUrl ?? "";
  const sessionOptions = sessions
    .listSessions()
    .map((session) => `<option value="${escapeHtml(session.id)}"${session.id === selectedId ? " selected" : ""}>${escapeHtml(session.id)}</option>`)
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LLM Telepresence Browser Lab Lite</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.45; max-width: 980px; }
      input, select, textarea, button { font: inherit; padding: .65rem; margin: .25rem 0; min-width: 18rem; }
      button { min-width: 10rem; cursor: pointer; }
      form { border: 1px solid #ccc; padding: 1rem; margin: 1rem 0; }
      img { max-width: 100%; border: 1px solid #ccc; }
      code, pre { background: #f5f5f5; padding: .2rem .35rem; }
    </style>
  </head>
  <body>
    <h1>LLM Telepresence Browser Lab Lite</h1>
    <p>Text-only controls for permissioned sessions. Use only on sites and conversations where you are authorized to participate.</p>

    <form method="post" action="/lite/create">
      <h2>Create Session</h2>
      <label>Admin token <input id="lite-token-create" name="token" value="${escapeHtml(token)}" autocomplete="off" /></label><br />
      <label>Initial URL <input id="lite-initial-url" name="initialUrl" placeholder="https://example.com" /></label><br />
      <button id="lite-create-session" type="submit">Create Session</button>
    </form>

    <form method="post" action="/lite/navigate">
      <h2>Navigate</h2>
      <input type="hidden" name="token" value="${escapeHtml(token)}" />
      <label>Session <select id="lite-session-select" name="session">${sessionOptions}</select></label><br />
      <label>URL <input id="lite-navigate-url" name="url" placeholder="https://example.com" /></label><br />
      <button id="lite-navigate" type="submit">Navigate</button>
    </form>

    <form method="post" action="/lite/action">
      <h2>Actions</h2>
      <input type="hidden" name="token" value="${escapeHtml(token)}" />
      <label>Session <select name="session">${sessionOptions}</select></label><br />
      <label>Action
        <select id="lite-action" name="action">
          <option value="screenshot">Screenshot</option>
          <option value="click">Click selector</option>
          <option value="type">Type into selector</option>
          <option value="key">Press key</option>
        </select>
      </label><br />
      <label>Selector <input id="lite-selector" name="selector" placeholder="button, #id, input[name=q]" /></label><br />
      <label>Text <textarea id="lite-text" name="text"></textarea></label><br />
      <label>Key <input id="lite-key" name="key" placeholder="Enter" /></label><br />
      <button id="lite-run-action" type="submit">Run Action</button>
    </form>

    <h2>Current Session</h2>
    <pre id="lite-status">${escapeHtml(JSON.stringify(selectedStatus ?? null, null, 2))}</pre>
    ${screenshot ? `<img id="lite-screenshot" alt="Latest screenshot" src="${screenshot}" />` : ""}
    <p><a id="lite-api-docs" href="/api-docs">API docs</a> | <a id="lite-full-ui" href="/">Full UI</a></p>
  </body>
</html>`;
}

function safeStatus(sessions: SessionManager, id: string) {
  try {
    return sessions.getStatus(id);
  } catch {
    return undefined;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function registerFrontend(app: FastifyInstance, config: AppConfig): Promise<void> {
  const webDist = config.webDistDir;
  if (!webDist || !existsSync(path.join(webDist, "index.html"))) {
    app.get("/", async (_request, reply) => {
      return reply.type("text/html").send(`
        <h1>LLM Telepresence Browser Lab</h1>
        <p>The API server is running, but the frontend build was not found.</p>
        <p>Run <code>npm run build --workspace=@telepresence/web</code> or use Vite dev server at <code>http://localhost:5173</code>.</p>
        <p><a href="/lite">Open Lite UI</a></p>
      `);
    });
    return;
  }

  await app.register(fastifyStatic, {
    root: webDist,
    prefix: "/",
    decorateReply: false
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api")) {
      return reply.code(404).send(errorResult("NOT_FOUND", "API route not found"));
    }
    if (request.url.startsWith("/lite")) {
      return reply.code(404).type("text/plain").send("Lite route not found");
    }
    return reply.type("text/html").send(createReadStream(path.join(webDist, "index.html")));
  });
}

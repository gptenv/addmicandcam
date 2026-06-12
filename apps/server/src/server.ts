import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { ApiResult, CreateSessionResponse } from "@telepresence/shared";
import { probeMediaTools, synthesizeSpeechWithEspeak } from "@telepresence/media";
import { createReadStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import { AssetStore } from "./assetStore.js";
import { HttpError } from "./errors.js";
import { mapExternalToolError, SessionManager } from "./sessionManager.js";

function toFastifySchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(toFastifySchema);
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (key === "$ref" && typeof value === "string") {
        const match = value.match(/^#\/components\/schemas\/(.+)$/);
        return [key, match ? `${match[1]}#` : value];
      }
      return [key, toFastifySchema(value)];
    })
  );
}

function normalizeOpenApiSchemaRefs(spec: any) {
  const schemas = spec?.components?.schemas;
  if (!schemas || typeof schemas !== "object") {
    return spec;
  }

  const aliases = new Map<string, string>();
  for (const [name, schema] of Object.entries(schemas)) {
    const title = schema && typeof schema === "object" ? (schema as { title?: unknown }).title : undefined;
    if (name.startsWith("def-") && typeof title === "string" && schemas[title]) {
      aliases.set(`#/components/schemas/${name}`, `#/components/schemas/${title}`);
    }
  }

  if (aliases.size === 0) {
    return spec;
  }

  const seen = new WeakSet<object>();
  const rewriteRefs = (value: unknown): void => {
    if (!value || typeof value !== "object") {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        rewriteRefs(item);
      }
      return;
    }

    const record = value as Record<string, unknown>;
    if (typeof record.$ref === "string" && aliases.has(record.$ref)) {
      record.$ref = aliases.get(record.$ref);
    }
    for (const child of Object.values(record)) {
      rewriteRefs(child);
    }
  };

  rewriteRefs(spec);
  return spec;
}

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
    bodyLimit: Math.max(config.uploadMaxBytes, 1024 * 1024),
    ajv: {
      customOptions: {
        strict: false
      }
    }
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(formbody);
  await app.register(multipart, {
    limits: {
      files: 1,
      fileSize: config.uploadMaxBytes
    }
  });

  const openApiSchemas: Record<string, any> = {
    // Reusable error shape (used by all error responses)
    ErrorResponse: {
      type: "object",
      properties: {
        ok: { type: "boolean", example: false },
        error: {
          type: "object",
          properties: {
            code: { type: "string", example: "SESSION_NOT_FOUND" },
            message: { type: "string", example: "No active session with id undefined" },
            details: { type: "object", nullable: true, additionalProperties: true },
          },
          required: ["code", "message"],
        },
      },
      required: ["ok", "error"],
    },

    // Specific response data shapes for every endpoint
    HealthData: {
      type: "object",
      properties: {
        status: { type: "string", example: "ok" },
        mediaTools: {
          type: "object",
          properties: {
            ffmpeg: { type: "boolean", example: true },
            espeak: { type: "boolean", example: false },
            errors: { type: "array", items: { type: "string" }, example: ["None of these commands are available: espeak-ng, espeak"] },
          },
          required: ["ffmpeg", "espeak", "errors"],
        },
        authRequired: { type: "boolean", example: false },
        maxSessions: { type: "integer", example: 4 },
      },
      required: ["status", "mediaTools", "authRequired", "maxSessions"],
    },

    SessionListData: {
      type: "array",
      items: { $ref: "#/components/schemas/BrowserSessionStatus" },
    },

    ScreenshotData: {
      type: "object",
      properties: {
        dataUrl: { type: "string", description: "data:image/png;base64,..." },
      },
      required: ["dataUrl"],
    },

    StateData: { $ref: "#/components/schemas/PageState" },

    EvaluateData: {
      type: "object",
      properties: {
        result: {},
        status: { $ref: "#/components/schemas/BrowserSessionStatus" },
      },
      required: ["status"],
    },

    ScrollData: { $ref: "#/components/schemas/PageScrollMetrics" },

    MediaUpdateData: { $ref: "#/components/schemas/BrowserSessionStatus" },

    AssetData: { $ref: "#/components/schemas/AssetMetadata" },

    TTSData: { $ref: "#/components/schemas/AssetMetadata" },

    CreateSessionData: { $ref: "#/components/schemas/CreateSessionResponse" },

    OkResponse: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        action: { type: "string" },
        data: { type: "object", additionalProperties: true },
      },
      required: ["ok"],
    },

    InputResultResponse: {
      type: "object",
      properties: {
        ok: { type: "boolean", example: true },
        action: { type: "string", example: "clicked" },
        data: { $ref: "#/components/schemas/BrowserSessionStatus" },
      },
      required: ["ok", "data"],
      example: {
        ok: true,
        action: "clicked",
        data: {
          id: "0615f8c9-...",
          active: true,
          currentUrl: "https://example.com",
          media: {
            camera: { mode: "off", active: false },
            mic: { mode: "off", active: false },
          },
          consoleLogs: [],
          recentErrors: [],
        },
      },
    },

    AssetListResponse: {
      type: "array",
      items: { $ref: "#/components/schemas/AssetMetadata" },
    },

    // Domain models with every field specified
    DisclosureConfig: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        label: { type: "string" },
      },
      required: ["enabled"],
    },

    CameraSourceConfig: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["off", "test-pattern", "image", "video", "generated"] },
        assetId: { type: "string", nullable: true },
        loop: { type: "boolean", nullable: true },
        active: { type: "boolean" },
        fileName: { type: "string", nullable: true },
        disclosure: { $ref: "#/components/schemas/DisclosureConfig", nullable: true },
        implementation: { type: "string", nullable: true },
        notes: { type: "array", items: { type: "string" }, nullable: true },
      },
      required: ["mode", "active"],
    },

    MicSourceConfig: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["off", "silence", "audio-file", "tts", "stream"] },
        assetId: { type: "string", nullable: true },
        loop: { type: "boolean", nullable: true },
        active: { type: "boolean" },
        fileName: { type: "string", nullable: true },
        voice: { type: "string", nullable: true },
        implementation: { type: "string", nullable: true },
        notes: { type: "array", items: { type: "string" }, nullable: true },
      },
      required: ["mode", "active"],
    },

    MediaStatus: {
      type: "object",
      properties: {
        camera: { $ref: "#/components/schemas/CameraSourceConfig" },
        mic: { $ref: "#/components/schemas/MicSourceConfig" },
      },
      required: ["camera", "mic"],
    },

    ConsoleLogEntry: {
      type: "object",
      properties: {
        id: { type: "string" },
        timestamp: { type: "string", format: "date-time" },
        type: { type: "string" },
        text: { type: "string" },
        location: { type: "string", nullable: true },
      },
      required: ["id", "timestamp", "type", "text"],
    },

    PageErrorEntry: {
      type: "object",
      properties: {
        id: { type: "string" },
        timestamp: { type: "string", format: "date-time" },
        message: { type: "string" },
        stack: { type: "string", nullable: true },
      },
      required: ["id", "timestamp", "message"],
    },

    BrowserSessionStatus: {
      type: "object",
      properties: {
        id: { type: "string" },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        expiresAt: { type: "string", format: "date-time" },
        active: { type: "boolean" },
        currentUrl: { type: "string" },
        title: { type: "string" },
        media: { $ref: "#/components/schemas/MediaStatus" },
        latestScreenshotDataUrl: { type: "string", nullable: true },
        consoleLogs: { type: "array", items: { $ref: "#/components/schemas/ConsoleLogEntry" } },
        recentErrors: { type: "array", items: { $ref: "#/components/schemas/PageErrorEntry" } },
      },
      required: ["id", "createdAt", "updatedAt", "expiresAt", "active", "currentUrl", "title", "media", "consoleLogs", "recentErrors"],
    },

    AssetMetadata: {
      type: "object",
      properties: {
        id: { type: "string" },
        kind: { type: "string", enum: ["image", "video", "audio", "other"] },
        originalName: { type: "string" },
        safeName: { type: "string" },
        mimeType: { type: "string" },
        bytes: { type: "integer" },
        createdAt: { type: "string", format: "date-time" },
        url: { type: "string", nullable: true },
        derivedFromAssetId: { type: "string", nullable: true },
      },
      required: ["id", "kind", "originalName", "safeName", "mimeType", "bytes", "createdAt"],
    },

    ElementSummary: {
      type: "object",
      properties: {
        tag: { type: "string" },
        role: { type: "string", nullable: true },
        selector: { type: "string" },
        text: { type: "string", nullable: true },
        href: { type: "string", nullable: true },
        placeholder: { type: "string", nullable: true },
        name: { type: "string", nullable: true },
        type: { type: "string", nullable: true },
        value: { type: "string", nullable: true },
      },
      required: ["tag", "selector"],
    },

    PageState: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        currentUrl: { type: "string" },
        title: { type: "string" },
        visibleText: { type: "string" },
        elements: { type: "array", items: { $ref: "#/components/schemas/ElementSummary" } },
        focusedElement: { $ref: "#/components/schemas/ElementSummary", nullable: true },
        consoleLogs: { type: "array", items: { $ref: "#/components/schemas/ConsoleLogEntry" } },
        recentErrors: { type: "array", items: { $ref: "#/components/schemas/PageErrorEntry" } },
        media: { $ref: "#/components/schemas/MediaStatus" },
        timestamp: { type: "string", format: "date-time" },
      },
      required: ["sessionId", "currentUrl", "title", "visibleText", "elements", "consoleLogs", "recentErrors", "media", "timestamp"],
    },

    PageScrollMetrics: {
      type: "object",
      properties: {
        scrollX: { type: "number", example: 0 },
        scrollY: { type: "number", example: 420 },
        scrollWidth: { type: "number", example: 1280 },
        scrollHeight: { type: "number", example: 2400 },
        clientWidth: { type: "number", example: 1280 },
        clientHeight: { type: "number", example: 720 },
        maxScrollX: { type: "number", example: 0 },
        maxScrollY: { type: "number", example: 1680 },
      },
      required: ["scrollX", "scrollY", "scrollWidth", "scrollHeight", "clientWidth", "clientHeight", "maxScrollX", "maxScrollY"],
    },

    CreateSessionResponse: {
      type: "object",
      properties: {
        session: { $ref: "#/components/schemas/BrowserSessionStatus" },
        urls: {
          type: "object",
          properties: {
            web: { type: "string" },
            lite: { type: "string" },
            api: { type: "string" },
            screenshot: { type: "string" },
            state: { type: "string" },
          },
          required: ["web", "lite", "api", "screenshot", "state"],
        },
      },
      required: ["session", "urls"],
    },
  };

  for (const [name, schema] of Object.entries(openApiSchemas)) {
    app.addSchema({ $id: name, ...(toFastifySchema(schema) as Record<string, unknown>) });
  }

  // OpenAPI / Swagger support - spec is generated at runtime from route definitions.
  // This ensures /openapi.json and the Swagger UI are always up-to-date on any deploy
  // (local npm start, Docker, Cloud Run, Cloud Build, etc.).
  await app.register(swagger, {
    openapi: {
      info: {
        title: "LLM Telepresence Browser Lab API",
        description:
          "Permissioned remote browser lab with synthetic camera and microphone inputs. " +
          "Designed for LLM agents, browser automation tools, testing, demos, and accessibility experiments. " +
          "Public API - no authentication required (no tokens, no Authorization header needed). " +
          "All responses follow the shape { ok: boolean, action?: string, data?: any, error?: { code: string, message: string, details?: any } }. " +
          "Synthetic media sources are for consented/authorized use only; disclosure watermarks are enabled by default.",
        version: "0.1.0",
        contact: {
          name: "LLM Telepresence Lab",
        },
      },
      servers: [{ url: config.baseUrl, description: "Current deployment" }],
      security: [], // Public API - no auth required
      components: {
        securitySchemes: {
          // Left for documentation; the API is public with no auth enforced.
          None: {
            type: "apiKey",
            in: "header",
            name: "Authorization",
            description: "No authentication is required. The API is fully public.",
          },
        },
        schemas: openApiSchemas,
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/swagger",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
    staticCSP: true,
  });

  app.get(
    "/openapi.json",
    {
      // Intentionally no response schema. Using a strict schema here causes Fastify's
      // serializer to drop most dynamic OpenAPI fields. We want the complete spec.
      schema: {
        tags: ["Meta"],
        summary: "OpenAPI 3.0 specification (autogenerated)",
        description: "Machine-readable OpenAPI spec for this API. Regenerated from route definitions at server startup.",
      },
    },
    async (request, reply) => {
      // Deep clone via JSON roundtrip guarantees a plain object that survives serialization
      // (the swagger plugin can return objects with getters/proxies).
      const spec = normalizeOpenApiSchemaRefs(JSON.parse(JSON.stringify(app.swagger())));
      const count = Object.keys(spec.paths || {}).length;
      request.log.info({ pathCount: count }, "openapi.json requested");
      return reply.send(spec);
    }
  );

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

  app.get("/api/health", {
    schema: {
      tags: ["Meta"],
      summary: "Health & capabilities check",
      description: "Returns whether the server is healthy and which media generation tools are available on the host (ffmpeg for image/video processing, espeak-ng/espeak for TTS). Useful as a first call for LLM agents.",
      response: {
        200: {
          description: "Successful health response",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  action: { type: "string" },
                  data: { $ref: "HealthData#" },
                },
                required: ["ok", "data"],
              },
              example: {
                ok: true,
                action: "state",
                data: {
                  status: "ok",
                  mediaTools: { ffmpeg: true, espeak: false, errors: ["None of these commands are available: espeak-ng, espeak"] },
                  authRequired: false,
                  maxSessions: 4,
                },
              },
            },
          },
        },
        500: { $ref: "ErrorResponse#" },
      },
    },
  }, async () => {
    return okResult("state", {
      status: "ok",
      mediaTools: await probeMediaTools(),
      authRequired: false,
      maxSessions: config.maxSessions
    });
  });

  app.post("/api/sessions", {
    preValidation: (request, _reply, done) => {
      if (request.body === undefined) {
        request.body = {};
      }
      done();
    },
    schema: {
      tags: ["Sessions"],
      summary: "Create a new browser session",
      description: "Launches a fresh isolated Playwright Chromium browser (headless by default). The session gets its own profile and is subject to the server's URL allow/block policies and private-network protections. Returns the full initial BrowserSessionStatus plus convenient URLs. The request body is optional (may be an empty object {}); providing initialUrl is recommended for immediate navigation.",
      body: {
        type: "object",
        properties: {
          initialUrl: { type: "string", format: "uri", description: "Optional URL to navigate to immediately after launch" },
        },
        additionalProperties: false,
        example: { initialUrl: "https://example.com" },
      },
      response: {
        200: {
          description: "Session created successfully",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  action: { type: "string" },
                  data: { $ref: "CreateSessionResponse#" },
                },
                required: ["ok", "data"],
              },
              example: {
                ok: true,
                action: "created",
                data: {
                  session: { id: "0615f8c9-2502-4e10-8f4d-adc1002b05b8", createdAt: "2026-06-12T08:12:07.390Z", active: true, currentUrl: "about:blank", title: "", media: { camera: { mode: "off", active: false }, mic: { mode: "off", active: false } }, consoleLogs: [], recentErrors: [] },
                  urls: {
                    web: "http://localhost:3000/session/0615f8c9-2502-4e10-8f4d-adc1002b05b8",
                    lite: "http://localhost:3000/lite?session=0615f8c9-2502-4e10-8f4d-adc1002b05b8",
                    api: "http://localhost:3000/api/sessions/0615f8c9-2502-4e10-8f4d-adc1002b05b8",
                    screenshot: "http://localhost:3000/api/sessions/0615f8c9-2502-4e10-8f4d-adc1002b05b8/screenshot",
                    state: "http://localhost:3000/api/sessions/0615f8c9-2502-4e10-8f4d-adc1002b05b8/state",
                  },
                },
              },
            },
          },
        },
      },
    },
  }, async (request) => {
    const body = request.body as { initialUrl?: string } | undefined;
    const session = await sessions.createSession(body?.initialUrl);
    return okResult<CreateSessionResponse>("created", {
      session,
      urls: sessionUrls(config.baseUrl, session.id)
    });
  });

  app.get("/api/sessions", {
    schema: {
      tags: ["Sessions"],
      summary: "List all active browser sessions",
      description: "Returns an array of current BrowserSessionStatus objects. Sessions are automatically cleaned up after their TTL expires.",
      response: {
        200: {
          description: "List of sessions",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  action: { type: "string" },
                  data: { $ref: "SessionListData#" },
                },
                required: ["ok", "data"],
              },
              example: {
                ok: true,
                action: "state",
                data: [{ id: "0615f8c9-...", active: true, currentUrl: "about:blank", title: "", media: { camera: { mode: "off", active: false }, mic: { mode: "off", active: false } }, consoleLogs: [], recentErrors: [] }],
              },
            },
          },
        },
      },
    },
  }, async () => {
    return okResult("state", sessions.listSessions());
  });

  app.get("/api/sessions/:id", {
    schema: {
      tags: ["Sessions"],
      summary: "Get full status of a session",
      description: "Returns the complete current BrowserSessionStatus. This is the main way for agents to 'see' what is on the page right now (visible elements, text, logs, errors, media state).",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Session UUID" } },
      },
      response: {
        200: {
          description: "Session status",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  action: { type: "string" },
                  data: { $ref: "BrowserSessionStatus#" },
                },
                required: ["ok", "data"],
              },
              example: { ok: true, action: "state", data: { id: "0615f8c9-...", active: true, currentUrl: "https://example.com", title: "Example", media: { camera: { mode: "off", active: false }, mic: { mode: "off", active: false } }, consoleLogs: [], recentErrors: [] } },
            },
          },
        },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    return okResult("state", sessions.getStatus(id));
  });

  app.delete("/api/sessions/:id", {
    schema: {
      tags: ["Sessions"],
      summary: "Terminate and delete a browser session",
      description: "Closes the Chromium browser for this session and cleans up all associated state and derived media files. The session becomes unavailable immediately.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Session UUID" } },
      },
      response: {
        200: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  action: { type: "string" },
                  data: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
                },
                required: ["ok", "data"],
              },
              example: { ok: true, action: "closed", data: { id: "0615f8c9-2502-4e10-8f4d-adc1002b05b8" } },
            },
          },
        },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    await sessions.deleteSession(id);
    return okResult("closed", { id });
  });

  app.post("/api/sessions/:id/navigate", {
    schema: {
      tags: ["Sessions"],
      summary: "Navigate the browser session",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
      body: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", format: "uri" },
        },
        example: { "url": "https://example.com" },
      },
      response: {
        200: {
          description: "Navigation result (updated session status)",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  action: { type: "string" },
                  data: { $ref: "EvaluateData#" },
                },
                required: ["ok", "data"],
              },
              example: { ok: true, action: "navigated", data: { id: "0615f8c9-...", currentUrl: "https://example.com", active: true, media: { camera: { mode: "off", active: false }, mic: { mode: "off", active: false } }, consoleLogs: [], recentErrors: [] } },
            },
          },
        },
        400: { $ref: "ErrorResponse#" },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const body = requireBody<{ url?: string }>(request);
    if (!body.url) {
      throw new HttpError(400, "URL_REQUIRED", "Body must include url");
    }
    return okResult("navigated", await sessions.navigate(id, body.url));
  });

  app.post("/api/sessions/:id/click", {
    schema: {
      tags: ["Sessions"],
      summary: "Click an element",
      description: "Performs a click on the first matching visible element. Uses Playwright locator.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Session UUID" } },
      },
      body: {
        type: "object",
        required: ["selector"],
        properties: {
          selector: { type: "string", description: "CSS selector or Playwright locator string, e.g. 'button', '#submit', 'text=Click me'" },
        },
        example: { "selector": "button.primary" },
      },
      response: {
        200: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  action: { type: "string" },
                  data: { $ref: "BrowserSessionStatus#" },
                },
                required: ["ok", "data"],
              },
            },
          },
        },
        400: { $ref: "ErrorResponse#" },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const body = requireBody<{ selector?: string }>(request);
    if (!body.selector) {
      throw new HttpError(400, "SELECTOR_REQUIRED", "Body must include selector");
    }
    return okResult("clicked", await sessions.click(id, body.selector));
  });

  app.post("/api/sessions/:id/type", {
    schema: {
      tags: ["Sessions"],
      summary: "Type text into an element",
      description: "Focuses the element then types the text with small delay. First clicks the element.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Session UUID" } },
      },
      body: {
        type: "object",
        required: ["selector"],
        properties: {
          selector: { type: "string", description: "CSS selector or locator" },
          text: { type: "string", description: "Text to type" },
        },
        example: { "selector": "textarea[name='message']", "text": "Hello from the lab" },
      },
      response: {
        200: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  action: { type: "string" },
                  data: { $ref: "BrowserSessionStatus#" },
                },
                required: ["ok", "data"],
              },
            },
          },
        },
        400: { $ref: "ErrorResponse#" },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const body = requireBody<{ selector?: string; text?: string }>(request);
    if (!body.selector) {
      throw new HttpError(400, "SELECTOR_REQUIRED", "Body must include selector");
    }
    return okResult("typed", await sessions.type(id, body.selector, body.text ?? ""));
  });

  app.post("/api/sessions/:id/key", {
    schema: {
      tags: ["Sessions"],
      summary: "Press a keyboard key",
      description: "Sends a key press event (e.g. Enter, Escape, ArrowDown). Does not require a selector.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Session UUID" } },
      },
      body: {
        type: "object",
        required: ["key"],
        properties: {
          key: { type: "string", description: "Key name as accepted by Playwright keyboard.press, e.g. 'Enter', 'Control+KeyA'" },
        },
        example: { "key": "Enter" },
      },
      response: {
        200: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  action: { type: "string" },
                  data: { $ref: "BrowserSessionStatus#" },
                },
                required: ["ok", "data"],
              },
            },
          },
        },
        400: { $ref: "ErrorResponse#" },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const body = requireBody<{ key?: string }>(request);
    if (!body.key) {
      throw new HttpError(400, "KEY_REQUIRED", "Body must include key");
    }
    return okResult("key-pressed", await sessions.pressKey(id, body.key));
  });

  app.post("/api/sessions/:id/evaluate", {
    schema: {
      tags: ["Sessions"],
      summary: "Evaluate JavaScript in the page",
      description: "Runs arbitrary JS via page.evaluate. Returns the result. Use with caution; no sandbox beyond Chromium's.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Session UUID" } },
      },
      body: {
        type: "object",
        required: ["script"],
        properties: {
          script: { type: "string", description: "JavaScript expression or IIFE to evaluate in the page context." },
        },
        example: { "script": "document.title" },
      },
      response: {
        200: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  action: { type: "string" },
                  data: { $ref: "EvaluateData#" },
                },
                required: ["ok", "data"],
              },
            },
          },
        },
        400: { $ref: "ErrorResponse#" },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const body = requireBody<{ script?: string }>(request);
    if (!body.script) {
      throw new HttpError(400, "SCRIPT_REQUIRED", "Body must include script");
    }
    return okResult("evaluated", await sessions.evaluate(id, body.script));
  });

  app.post("/api/sessions/:id/reload", {
    schema: {
      tags: ["Sessions"],
      summary: "Reload the current page",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Session UUID" } },
      },
      body: {
        type: "object",
        additionalProperties: false,
        example: {},
      },
      response: {
        200: { $ref: "OkResponse#" },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    return okResult("navigated", await sessions.reload(id));
  });

  app.post("/api/sessions/:id/back", {
    schema: {
      tags: ["Sessions"],
      summary: "Navigate back in history",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Session UUID" } },
      },
      body: {
        type: "object",
        additionalProperties: false,
        example: {},
      },
      response: {
        200: { $ref: "OkResponse#" },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    return okResult("navigated", await sessions.back(id));
  });

  app.post("/api/sessions/:id/forward", {
    schema: {
      tags: ["Sessions"],
      summary: "Navigate forward in history",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Session UUID" } },
      },
      body: {
        type: "object",
        additionalProperties: false,
        example: {},
      },
      response: {
        200: { $ref: "OkResponse#" },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    return okResult("navigated", await sessions.forward(id));
  });

  // New coordinate-based input endpoints for interactive viewport / Agent Mode passthrough.
  // Coordinates are in Playwright viewport space (e.g. 1280x720). Frontend scales from rendered image.
  app.post("/api/sessions/:id/input/click", {
    schema: {
      tags: ["Input"],
      summary: "Click at viewport coordinates",
      description: "Sends a mouse click at the given (x, y) in the browser viewport. Use this for interactive passthrough instead of (or in addition to) selector clicks.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Session UUID" } },
      },
      body: {
        type: "object",
        required: ["x", "y"],
        properties: {
          x: { type: "number", description: "Viewport x coordinate" },
          y: { type: "number", description: "Viewport y coordinate" },
          button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
        },
        example: { "x": 320, "y": 240, "button": "left" },
      },
      response: {
        200: { $ref: "InputResultResponse#" },
        400: { $ref: "ErrorResponse#" },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const body = requireBody<{ x: number; y: number; button?: "left" | "right" | "middle" }>(request);
    return okResult("clicked", await sessions.mouseClick(id, body));
  });

  app.post("/api/sessions/:id/input/move", {
    schema: {
      tags: ["Input"],
      summary: "Move mouse to viewport coordinates",
      description: "Moves the mouse cursor to the given (x, y) in viewport. Useful for hover effects before click.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Session UUID" } },
      },
      body: {
        type: "object",
        required: ["x", "y"],
        properties: {
          x: { type: "number" },
          y: { type: "number" },
        },
        example: { "x": 320, "y": 240 },
      },
      response: {
        200: { $ref: "InputResultResponse#" },
        400: { $ref: "ErrorResponse#" },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const body = requireBody<{ x: number; y: number }>(request);
    return okResult("moved", await sessions.mouseMove(id, body));
  });

  app.post("/api/sessions/:id/input/wheel", {
    preValidation: (request, _reply, done) => {
      if (request.body === undefined) {
        request.body = {};
      }
      done();
    },
    schema: {
      tags: ["Input"],
      summary: "Scroll / wheel at current position",
      description: "Simulates mouse wheel scroll. Positive deltaY scrolls down.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Session UUID" } },
      },
      body: {
        type: "object",
        properties: {
          deltaX: { type: "number", default: 0 },
          deltaY: { type: "number", default: 0 },
        },
        example: { "deltaX": 0, "deltaY": 420 },
      },
      response: {
        200: { $ref: "InputResultResponse#" },
        400: { $ref: "ErrorResponse#" },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body as { deltaX?: number; deltaY?: number } | undefined) ?? {};
    return okResult("scrolled", await sessions.mouseWheel(id, body));
  });

  app.get("/api/sessions/:id/scroll", {
    schema: {
      tags: ["Input"],
      summary: "Get page scroll metrics",
      description: "Returns top-level document scroll offsets and dimensions for rendering a remote-browser scrollbar in the control UI.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Session UUID" } },
      },
      response: {
        200: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  action: { type: "string" },
                  data: { $ref: "ScrollData#" },
                },
                required: ["ok", "data"],
              },
              example: {
                ok: true,
                action: "state",
                data: {
                  scrollX: 0,
                  scrollY: 420,
                  scrollWidth: 1280,
                  scrollHeight: 2400,
                  clientWidth: 1280,
                  clientHeight: 720,
                  maxScrollX: 0,
                  maxScrollY: 1680,
                },
              },
            },
          },
        },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    return okResult("state", await sessions.pageScrollMetrics(id));
  });

  app.post("/api/sessions/:id/input/scroll", {
    schema: {
      tags: ["Input"],
      summary: "Scroll page to absolute offset",
      description: "Sets the top-level document scroll offset. Used by the remote-browser scrollbar next to the screenshot viewport.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Session UUID" } },
      },
      body: {
        type: "object",
        properties: {
          scrollX: { type: "number", description: "Absolute horizontal scroll offset" },
          scrollY: { type: "number", description: "Absolute vertical scroll offset" },
        },
        example: { scrollY: 420 },
      },
      response: {
        200: { $ref: "InputResultResponse#" },
        400: { $ref: "ErrorResponse#" },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const body = requireBody<{ scrollX?: number; scrollY?: number }>(request);
    return okResult("scrolled", await sessions.scrollTo(id, body));
  });

  app.post("/api/sessions/:id/input/type", {
    schema: {
      tags: ["Input"],
      summary: "Type text at current focus (viewport mode)",
      description: "Types printable text using keyboard. For agent passthrough over the screenshot surface. Does not require selector.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Session UUID" } },
      },
      body: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", description: "Text to type into focused element or page" },
        },
        example: { "text": "hello" },
      },
      response: {
        200: { $ref: "InputResultResponse#" },
        400: { $ref: "ErrorResponse#" },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const body = requireBody<{ text: string }>(request);
    return okResult("typed", await sessions.keyboardType(id, body));
  });

  app.post("/api/sessions/:id/input/key", {
    schema: {
      tags: ["Input"],
      summary: "Press a key (viewport mode)",
      description: "Presses a special key or combination. Reuses existing keyboard press. Good for Enter, arrows, etc. when interacting with the screenshot viewport.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Session UUID" } },
      },
      body: {
        type: "object",
        required: ["key"],
        properties: {
          key: { type: "string", description: "Key to press, e.g. Enter, ArrowDown, Escape, Backspace" },
        },
        example: { "key": "Enter" },
      },
      response: {
        200: { $ref: "InputResultResponse#" },
        400: { $ref: "ErrorResponse#" },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const body = requireBody<{ key: string }>(request);
    return okResult("key-pressed", await sessions.keyboardPress(id, body.key));
  });

  app.get("/api/sessions/:id/screenshot", {
    schema: {
      tags: ["Diagnostics"],
      summary: "Capture screenshot of the current page",
      description: "Takes a PNG screenshot of the visible viewport. By default returns a JSON response containing a data: URL. Append ?format=png to receive the raw image bytes directly (useful for saving or piping).",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Session UUID" } },
      },
      querystring: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["png"],
            description: "When set to 'png' the response body is the raw image instead of { dataUrl: '...' }",
          },
        },
      },
      response: {
        200: {
          description: "Screenshot (JSON data URL or raw PNG)",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  action: { type: "string" },
                  data: { $ref: "ScreenshotData#" },
                },
                required: ["ok", "data"],
              },
              example: { ok: true, action: "screenshot", data: { dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==" } },
            },
            "image/png": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { format?: string } | undefined;
    const dataUrl = await sessions.screenshot(id);
    if (query?.format === "png") {
      const base64 = dataUrl.split(",")[1] ?? "";
      return reply.type("image/png").send(Buffer.from(base64, "base64"));
    }
    return okResult("screenshot", { dataUrl });
  });

  app.get("/api/sessions/:id/state", {
    schema: {
      tags: ["Diagnostics"],
      summary: "Get rich page state",
      description: "Returns title, currentUrl, visible text, list of interactive elements with good selectors, focused element, console logs, recent errors, and current media configuration. This is the primary observation endpoint for agents.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Session UUID" } },
      },
      response: {
        200: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  action: { type: "string" },
                  data: { $ref: "PageState#" },
                },
                required: ["ok", "data"],
              },
              example: { ok: true, action: "state", data: { sessionId: "0615f8c9-...", currentUrl: "https://example.com", title: "Example Domain", visibleText: "This domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.", elements: [{ tag: "a", selector: "a", text: "More information..." }], focusedElement: null, consoleLogs: [], recentErrors: [], media: { camera: { mode: "off", active: false }, mic: { mode: "off", active: false } }, timestamp: "2026-06-12T08:12:10.000Z" } },
            },
          },
        },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    return okResult("state", await sessions.pageState(id));
  });

  app.post("/api/sessions/:id/media/camera", {
    schema: {
      tags: ["Media"],
      summary: "Configure synthetic camera input",
      description: "Updates the fake video device seen by the page's getUserMedia/WebRTC. Changing camera source (except to 'off'/'test-pattern') will **relaunch** the Chromium instance for that session (current URL is restored but transient page state may be lost). Disclosure watermark is burned in by ffmpeg when enabled. Request body examples: off: {\"mode\":\"off\"}, test-pattern: {\"mode\":\"test-pattern\"}, image: {\"mode\":\"image\",\"assetId\":\"...\",\"disclosure\":{\"enabled\":true,\"label\":\"AI-assisted\"}}",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Session UUID" } },
      },
      body: {
        type: "object",
        required: ["mode"],
        properties: {
          mode: {
            type: "string",
            enum: ["off", "test-pattern", "generated", "image", "video"],
            description: "off = disable, test-pattern = built-in Chromium fake, image/video = use uploaded asset converted to Y4M",
          },
          assetId: { type: "string", description: "Asset ID (from POST /api/assets). Required for image and video modes." },
          loop: { type: "boolean", default: true, description: "Loop the video clip (video mode only)." },
          disclosure: {
            type: "object",
            properties: {
              enabled: { type: "boolean", default: true },
              label: { type: "string", example: "AI-assisted" },
            },
            description: "Optional text overlay (burned into the Y4M stream via ffmpeg drawtext).",
          },
        },
        example: {
          mode: "image",
          assetId: "a1b2c3d4-...",
          disclosure: { enabled: true, label: "AI-assisted" },
        },
      },
      response: {
        200: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  action: { type: "string" },
                  data: { $ref: "MediaUpdateData#" },
                },
                required: ["ok", "data"],
              },
              example: { ok: true, action: "media-updated", data: { id: "0615f8c9-...", active: true, currentUrl: "https://example.com", media: { camera: { mode: "image", active: true, assetId: "a1b2c3d4-...", disclosure: { enabled: true, label: "AI-assisted" } }, mic: { mode: "off", active: false } }, consoleLogs: [], recentErrors: [] } },
            },
          },
        },
        400: { $ref: "ErrorResponse#" },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    return okResult("media-updated", await sessions.setCameraSource(id, requireBody(request)));
  });

  app.post("/api/sessions/:id/media/mic", {
    schema: {
      tags: ["Media"],
      summary: "Set or change the synthetic microphone source",
      description: "Changes the fake mic. Requires browser relaunch in most cases. Modes: off, silence, audio-file, tts. 'silence' also installs a Web Audio getUserMedia fallback. Request body examples: off: {\"mode\":\"off\"}, silence: {\"mode\":\"silence\"}, tts: {\"mode\":\"tts\",\"text\":\"Hello, this is a synthetic microphone.\",\"voice\":\"default\"}, audio-file: {\"mode\":\"audio-file\",\"assetId\":\"...\",\"loop\":false}",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Session UUID" } },
      },
      body: {
        type: "object",
        required: ["mode"],
        properties: {
          mode: { type: "string", enum: ["off", "silence", "audio-file", "tts"], description: "Microphone source mode." },
          assetId: { type: "string", description: "For audio-file mode." },
          text: { type: "string", description: "For tts mode." },
          voice: { type: "string", description: "Optional voice for tts." },
          loop: { type: "boolean", description: "For audio-file with loop." },
        },
        example: { "mode": "tts", "text": "Hello, this is a synthetic microphone.", "voice": "default" },
      },
      response: {
        200: { $ref: "OkResponse#" },
        400: { $ref: "ErrorResponse#" },
        404: { $ref: "ErrorResponse#" },
        501: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    return okResult("media-updated", await sessions.setMicSource(id, requireBody(request)));
  });

  app.get("/api/sessions/:id/stream", {
    schema: {
      tags: ["Diagnostics"],
      summary: "SSE screenshot + status stream",
      description: "Server-sent events endpoint. Emits 'screenshot' events with data URL + full status every ~3s. Useful for live observation without polling.",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Session UUID" } },
      },
      response: {
        200: { description: "text/event-stream" },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request, reply) => {
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

  app.get("/api/assets", {
    schema: {
      tags: ["Assets"],
      summary: "List all assets",
      description: "Returns metadata for uploaded images/videos/audios and generated TTS/silence assets. Does not include the file bytes (use /file endpoint).",
      response: {
        200: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  action: { type: "string" },
                  data: { $ref: "AssetListResponse#" },
                },
                required: ["ok", "data"],
              },
            },
          },
        },
      },
    },
  }, async () => {
    return okResult("state", assets.list());
  });

  app.post("/api/assets", {
    schema: {
      tags: ["Assets"],
      summary: "Upload an asset (image, video, or audio)",
      description: "Uploaded files can be used as synthetic camera or microphone sources.",
      consumes: ["multipart/form-data"],
      body: {
        type: "object",
        properties: {
          file: {
            type: "string",
            format: "binary",
            description: "The file to upload (image, video, or audio). Use multipart/form-data with field name 'file'."
          }
        },
        required: ["file"]
      },
      response: {
        200: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  action: { type: "string" },
                  data: { $ref: "AssetData#" },
                },
                required: ["ok", "data"],
              },
              example: { ok: true, action: "created", data: { id: "a1b2c3d4-...", kind: "image", originalName: "avatar.png", safeName: "avatar.png", mimeType: "image/png", bytes: 12345, createdAt: "2026-06-12T08:12:05.000Z" } },
            },
          },
        },
        400: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
    const upload = await request.file();
    if (!upload) {
      throw new HttpError(400, "FILE_REQUIRED", "Multipart request must include a file field");
    }
    return okResult("created", await assets.createFromUpload(upload));
  });

  app.get("/api/assets/:id/file", {
    schema: {
      tags: ["Assets"],
      summary: "Download an asset file",
      description: "Returns the raw bytes of an uploaded or generated asset (image, video, or audio).",
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Asset UUID returned by POST /api/assets or POST /api/tts" } },
      },
      response: {
        200: { description: "The asset file (Content-Type based on original mime type)" },
        404: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const asset = assets.get(id);
    if (!asset) {
      throw new HttpError(404, "ASSET_NOT_FOUND", `No asset with id ${id}`);
    }
    return reply.type(asset.mimeType).send(assets.createReadStream(id));
  });

  app.post("/api/tts", {
    schema: {
      tags: ["TTS"],
      summary: "Generate TTS audio and register as asset",
      description: "Uses espeak-ng/espeak (must be installed on the server). The resulting WAV can be used as a mic source.",
      body: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string" },
          voice: { type: "string" },
        },
        example: { "text": "Hello, I am testing audio.", "voice": "default" },
      },
      response: {
        200: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  action: { type: "string" },
                  data: { $ref: "TTSData#" },
                },
                required: ["ok", "data"],
              },
              example: { ok: true, action: "created", data: { id: "tts-uuid-1234", kind: "audio", originalName: "tts.wav", safeName: "tts.wav", mimeType: "audio/wav", bytes: 4821, createdAt: "2026-06-12T08:12:09.000Z" } },
            },
          },
        },
        400: { $ref: "ErrorResponse#" },
      },
    },
  }, async (request) => {
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

  // Redirect old /api-docs to the new Swagger UI (autogenerated OpenAPI)
  app.get("/api-docs", async (_request, reply) => {
    return reply.redirect("/swagger");
  });

  app.get("/lite", async (request, reply) => {
    return reply.type("text/html").send(renderLitePage(config, request, sessions));
  });

  app.post("/lite/create", { schema: { hide: true } }, async (request, reply) => {
    const body = request.body as { initialUrl?: string } | undefined;
    const session = await sessions.createSession(body?.initialUrl || undefined);
    return reply.redirect(`/lite?session=${encodeURIComponent(session.id)}`);
  });

  app.post("/lite/navigate", { schema: { hide: true } }, async (request, reply) => {
    const body = request.body as { session?: string; url?: string } | undefined;
    if (!body?.session || !body.url) {
      throw new HttpError(400, "FORM_REQUIRED", "session and url are required");
    }
    await sessions.navigate(body.session, body.url);
    return reply.redirect(`/lite?session=${encodeURIComponent(body.session)}`);
  });

  app.post("/lite/action", { schema: { hide: true } }, async (request, reply) => {
    const body = request.body as {
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
    return reply.redirect(`/lite?session=${encodeURIComponent(body.session)}`);
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

function renderLitePage(config: AppConfig, request: FastifyRequest, sessions: SessionManager): string {
  const query = request.query as { session?: string } | undefined;
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
    <p>Text-only controls. Use only on sites and conversations where you have permission to participate.</p>

    <form method="post" action="/lite/create">
      <h2>Create Session</h2>
      <label>Initial URL <input id="lite-initial-url" name="initialUrl" placeholder="https://example.com" /></label><br />
      <button id="lite-create-session" type="submit">Create Session</button>
    </form>

    <form method="post" action="/lite/navigate">
      <h2>Navigate</h2>
      <label>Session <select id="lite-session-select" name="session">${sessionOptions}</select></label><br />
      <label>URL <input id="lite-navigate-url" name="url" placeholder="https://example.com" /></label><br />
      <button id="lite-navigate" type="submit">Navigate</button>
    </form>

    <form method="post" action="/lite/action">
      <h2>Actions</h2>
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
    <p><a id="lite-api-docs" href="/swagger">Swagger UI</a> | <a id="lite-openapi" href="/openapi.json">OpenAPI Spec</a> | <a id="lite-full-ui" href="/">Full UI</a></p>
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

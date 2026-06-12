import type {
  BrowserSessionStatus,
  CameraRequest,
  CameraSourceConfig,
  ConsoleLogEntry,
  MediaStatus,
  MicRequest,
  MicSourceConfig,
  PageScrollMetrics,
  PageErrorEntry,
  PageState
} from "@telepresence/shared";
import {
  ExternalToolError,
  generateSilenceWav,
  imageToY4M,
  normalizeAudioToWav,
  synthesizeSpeechWithEspeak,
  videoToY4M
} from "@telepresence/media";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { validateTargetUrl } from "./urlPolicy.js";
import type { AssetStore, StoredAssetMetadata } from "./assetStore.js";

interface InternalCameraConfig extends CameraSourceConfig {
  capturePath?: string;
}

interface InternalMicConfig extends MicSourceConfig {
  capturePath?: string;
}

interface InternalMediaStatus {
  camera: InternalCameraConfig;
  mic: InternalMicConfig;
}

interface ManagedSession {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  currentUrl: string;
  title: string;
  active: boolean;
  media: InternalMediaStatus;
  latestScreenshotDataUrl?: string;
  consoleLogs: ConsoleLogEntry[];
  recentErrors: PageErrorEntry[];
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfig,
    private readonly assets: AssetStore
  ) {}

  startCleanupLoop(): void {
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired();
    }, 30_000);
    this.cleanupTimer.unref();
  }

  async closeAll(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    await Promise.all([...this.sessions.keys()].map((id) => this.deleteSession(id).catch(() => undefined)));
  }

  listSessions(): BrowserSessionStatus[] {
    return [...this.sessions.values()].map((session) => this.toStatus(session));
  }

  getStatus(id: string): BrowserSessionStatus {
    return this.toStatus(this.requireSession(id));
  }

  async createSession(initialUrl?: string): Promise<BrowserSessionStatus> {
    if (this.sessions.size >= this.config.maxSessions) {
      throw new HttpError(429, "MAX_SESSIONS", `Maximum concurrent session count is ${this.config.maxSessions}`);
    }
    const id = randomUUID();
    const now = new Date();
    const session: ManagedSession = {
      id,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + this.config.sessionTtlMs),
      currentUrl: "about:blank",
      title: "",
      active: false,
      media: {
        camera: {
          mode: "off",
          active: false,
          disclosure: { ...this.config.disclosure },
          notes: ["Camera is off until a test pattern, image, or video source is selected."]
        },
        mic: {
          mode: "off",
          active: false,
          notes: ["Microphone is off until silence, TTS, or an audio asset is selected."]
        }
      },
      consoleLogs: [],
      recentErrors: []
    };
    this.sessions.set(id, session);
    await this.launchBrowser(session);
    if (initialUrl) {
      await this.navigate(id, initialUrl);
    }
    return this.toStatus(session);
  }

  async deleteSession(id: string): Promise<void> {
    const session = this.requireSession(id);
    await this.closeBrowser(session);
    this.sessions.delete(id);
  }

  async navigate(id: string, rawUrl: string): Promise<BrowserSessionStatus> {
    const policy = validateTargetUrl(rawUrl, this.config);
    if (!policy.ok || !policy.url) {
      throw new HttpError(400, "URL_BLOCKED", policy.reason ?? "URL is not allowed");
    }
    const session = this.requireSession(id);
    const page = await this.requirePage(session);
    try {
      await page.goto(policy.url.href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (error) {
      this.pushError(session, error);
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(502, "NAVIGATION_FAILED", message);
    }
    await this.refreshPageMetadata(session);
    return this.toStatus(session);
  }

  async reload(id: string): Promise<BrowserSessionStatus> {
    const session = this.requireSession(id);
    const page = await this.requirePage(session);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
    await this.refreshPageMetadata(session);
    return this.toStatus(session);
  }

  async back(id: string): Promise<BrowserSessionStatus> {
    const session = this.requireSession(id);
    const page = await this.requirePage(session);
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
    await this.refreshPageMetadata(session);
    return this.toStatus(session);
  }

  async forward(id: string): Promise<BrowserSessionStatus> {
    const session = this.requireSession(id);
    const page = await this.requirePage(session);
    await page.goForward({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
    await this.refreshPageMetadata(session);
    return this.toStatus(session);
  }

  async click(id: string, selector: string): Promise<BrowserSessionStatus> {
    const session = this.requireSession(id);
    const page = await this.requirePage(session);
    await page.locator(selector).first().click({ timeout: 15_000 });
    await this.refreshPageMetadata(session);
    return this.toStatus(session);
  }

  async type(id: string, selector: string, text: string): Promise<BrowserSessionStatus> {
    const session = this.requireSession(id);
    const page = await this.requirePage(session);
    const locator = page.locator(selector).first();
    await locator.click({ timeout: 15_000 });
    await page.keyboard.type(text, { delay: 10 });
    await this.refreshPageMetadata(session);
    return this.toStatus(session);
  }

  async pressKey(id: string, key: string): Promise<BrowserSessionStatus> {
    const session = this.requireSession(id);
    const page = await this.requirePage(session);
    await page.keyboard.press(key);
    await this.refreshPageMetadata(session);
    return this.toStatus(session);
  }

  async mouseClick(id: string, { x, y, button = "left" as "left" | "right" | "middle" }: { x: number; y: number; button?: "left" | "right" | "middle" }): Promise<BrowserSessionStatus> {
    const session = this.requireSession(id);
    const page = await this.requirePage(session);
    await page.mouse.click(x, y, { button });
    await this.refreshPageMetadata(session);
    return this.toStatus(session);
  }

  async mouseMove(id: string, { x, y }: { x: number; y: number }): Promise<BrowserSessionStatus> {
    const session = this.requireSession(id);
    const page = await this.requirePage(session);
    await page.mouse.move(x, y);
    await this.refreshPageMetadata(session);
    return this.toStatus(session);
  }

  async mouseWheel(id: string, { deltaX = 0, deltaY = 0 }: { deltaX?: number; deltaY?: number }): Promise<BrowserSessionStatus> {
    const session = this.requireSession(id);
    const page = await this.requirePage(session);
    await page.mouse.wheel(deltaX, deltaY);
    await this.refreshPageMetadata(session);
    return this.toStatus(session);
  }

  async pageScrollMetrics(id: string): Promise<PageScrollMetrics> {
    const session = this.requireSession(id);
    const page = await this.requirePage(session);
    return page.evaluate(() => {
      const root = document.scrollingElement || document.documentElement;
      const scrollX = window.scrollX || root.scrollLeft || 0;
      const scrollY = window.scrollY || root.scrollTop || 0;
      const scrollWidth = Math.max(root.scrollWidth, document.body?.scrollWidth || 0, window.innerWidth);
      const scrollHeight = Math.max(root.scrollHeight, document.body?.scrollHeight || 0, window.innerHeight);
      const clientWidth = window.innerWidth;
      const clientHeight = window.innerHeight;
      return {
        scrollX,
        scrollY,
        scrollWidth,
        scrollHeight,
        clientWidth,
        clientHeight,
        maxScrollX: Math.max(0, scrollWidth - clientWidth),
        maxScrollY: Math.max(0, scrollHeight - clientHeight),
      };
    });
  }

  async scrollTo(id: string, { scrollX, scrollY }: { scrollX?: number; scrollY?: number }): Promise<BrowserSessionStatus> {
    const session = this.requireSession(id);
    const page = await this.requirePage(session);
    await page.evaluate(({ left, top }) => {
      const currentX = window.scrollX || document.scrollingElement?.scrollLeft || 0;
      const currentY = window.scrollY || document.scrollingElement?.scrollTop || 0;
      window.scrollTo({
        left: typeof left === "number" ? left : currentX,
        top: typeof top === "number" ? top : currentY,
        behavior: "instant",
      });
    }, { left: scrollX, top: scrollY });
    await this.refreshPageMetadata(session);
    return this.toStatus(session);
  }

  async keyboardType(id: string, { text }: { text: string }): Promise<BrowserSessionStatus> {
    const session = this.requireSession(id);
    const page = await this.requirePage(session);
    await page.keyboard.type(text, { delay: 10 });
    await this.refreshPageMetadata(session);
    return this.toStatus(session);
  }

  // keyboardPress reuses pressKey for viewport-specific route
  async keyboardPress(id: string, key: string): Promise<BrowserSessionStatus> {
    return this.pressKey(id, key);
  }

  async evaluate(id: string, script: string): Promise<{ result: unknown; status: BrowserSessionStatus }> {
    const session = this.requireSession(id);
    const page = await this.requirePage(session);
    const result = await page.evaluate((source) => {
      return (0, eval)(source);
    }, script);
    await this.refreshPageMetadata(session);
    return { result, status: this.toStatus(session) };
  }

  async screenshot(id: string): Promise<string> {
    const session = this.requireSession(id);
    const page = await this.requirePage(session);
    const buffer = await page.screenshot({ type: "png", fullPage: false });
    const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
    session.latestScreenshotDataUrl = dataUrl;
    this.touch(session);
    return dataUrl;
  }

  async pageState(id: string): Promise<PageState> {
    const session = this.requireSession(id);
    const page = await this.requirePage(session);
    const snapshot = await page.evaluate(() => {
      const cssEscape = (value: string) => {
        if (globalThis.CSS && typeof globalThis.CSS.escape === "function") {
          return globalThis.CSS.escape(value);
        }
        return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      };
      const textOf = (element: Element) => (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180);
      const isVisible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (rect.width > 0 || rect.height > 0) && style.visibility !== "hidden" && style.display !== "none";
      };
      const selectorFor = (element: Element) => {
        if (element.id) {
          return `#${cssEscape(element.id)}`;
        }
        const aria = element.getAttribute("aria-label");
        if (aria) {
          return `${element.tagName.toLowerCase()}[aria-label="${aria.replace(/"/g, '\\"')}"]`;
        }
        const name = element.getAttribute("name");
        if (name) {
          return `${element.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]`;
        }
        const parts: string[] = [];
        let current: Element | null = element;
        while (current && current !== document.body && parts.length < 5) {
          const tag = current.tagName.toLowerCase();
          const parent: Element | null = current.parentElement;
          if (!parent) {
            parts.unshift(tag);
            break;
          }
          const currentTag = current.tagName;
          const siblings = Array.from(parent.children).filter((sibling) => sibling.tagName === currentTag);
          const index = siblings.indexOf(current) + 1;
          parts.unshift(`${tag}:nth-of-type(${index})`);
          current = parent;
        }
        return parts.join(" > ");
      };
      const summarize = (element: Element) => {
        const input = element instanceof HTMLInputElement ? element : undefined;
        const textarea = element instanceof HTMLTextAreaElement ? element : undefined;
        const anchor = element instanceof HTMLAnchorElement ? element : undefined;
        return {
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role") || undefined,
          selector: selectorFor(element),
          text: textOf(element) || undefined,
          href: anchor?.href,
          placeholder: input?.placeholder || textarea?.placeholder || undefined,
          name: element.getAttribute("name") || undefined,
          type: input?.type,
          value: input?.value || textarea?.value || undefined
        };
      };

      const elements = Array.from(
        document.querySelectorAll("a,button,input,textarea,select,[role='button'],[contenteditable='true']")
      )
        .filter(isVisible)
        .slice(0, 80)
        .map(summarize);

      const focused =
        document.activeElement && document.activeElement !== document.body && isVisible(document.activeElement)
          ? summarize(document.activeElement)
          : undefined;

      return {
        title: document.title,
        currentUrl: window.location.href,
        visibleText: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 5000),
        elements,
        focusedElement: focused
      };
    });
    session.currentUrl = snapshot.currentUrl;
    session.title = snapshot.title;
    this.touch(session);
    return {
      sessionId: session.id,
      currentUrl: snapshot.currentUrl,
      title: snapshot.title,
      visibleText: snapshot.visibleText,
      elements: snapshot.elements,
      focusedElement: snapshot.focusedElement,
      consoleLogs: [...session.consoleLogs],
      recentErrors: [...session.recentErrors],
      media: this.publicMedia(session),
      timestamp: new Date().toISOString()
    };
  }

  async setCameraSource(id: string, request: CameraRequest): Promise<BrowserSessionStatus> {
    const session = this.requireSession(id);
    if (request.mode === "off") {
      session.media.camera = {
        mode: "off",
        active: false,
        disclosure: request.disclosure ?? { ...this.config.disclosure },
        notes: ["Camera source is disabled."]
      };
      await this.restartBrowser(session);
      return this.toStatus(session);
    }

    if (request.mode === "test-pattern" || request.mode === "generated") {
      session.media.camera = {
        mode: request.mode,
        active: true,
        disclosure: request.disclosure ?? { ...this.config.disclosure },
        implementation: "Chromium fake media test pattern",
        notes: ["Uses Chromium's built-in fake video device."]
      };
      await this.restartBrowser(session);
      return this.toStatus(session);
    }

    const asset = this.requireAsset(request.assetId);
    if (request.mode === "image" && asset.kind !== "image") {
      throw new HttpError(400, "INVALID_ASSET_KIND", "Camera image mode requires an image asset");
    }
    if (request.mode === "video" && asset.kind !== "video") {
      throw new HttpError(400, "INVALID_ASSET_KIND", "Camera video mode requires a video asset");
    }

    const outputPath = this.derivedPath(session, asset, "y4m");
    const disclosure = request.disclosure ?? { ...this.config.disclosure };
    const options = {
      width: this.config.viewport.width,
      height: this.config.viewport.height,
      fps: this.config.fakeVideo.fps,
      durationSeconds: this.config.fakeVideo.durationSeconds,
      loop: request.loop ?? true,
      overlay: {
        enabled: disclosure.enabled,
        label: disclosure.label,
        sessionId: session.id.slice(0, 8)
      }
    };
    if (request.mode === "image") {
      await imageToY4M(asset.path, outputPath, options);
    } else {
      await videoToY4M(asset.path, outputPath, options);
    }

    session.media.camera = {
      mode: request.mode,
      assetId: asset.id,
      loop: request.loop ?? true,
      active: true,
      fileName: asset.originalName,
      disclosure,
      capturePath: outputPath,
      implementation: "Chromium --use-file-for-fake-video-capture",
      notes: ["Media changes relaunch the isolated Chromium session and preserve the current URL."]
    };
    await this.restartBrowser(session);
    return this.toStatus(session);
  }

  async setMicSource(id: string, request: MicRequest): Promise<BrowserSessionStatus> {
    const session = this.requireSession(id);
    if (request.mode === "off") {
      session.media.mic = {
        mode: "off",
        active: false,
        notes: ["Microphone source is disabled."]
      };
      await this.restartBrowser(session);
      return this.toStatus(session);
    }

    if (request.mode === "stream") {
      throw new HttpError(
        501,
        "STREAM_MIC_NOT_IMPLEMENTED",
        "Live streamed microphone input is reserved for a future PipeWire/PulseAudio/WebRTC integration"
      );
    }

    const durationSeconds = Math.max(2, this.config.fakeVideo.durationSeconds);
    let capturePath: string;
    let fileName: string | undefined;
    let assetId: string | undefined;
    let voice = request.voice;

    if (request.mode === "silence") {
      capturePath = this.derivedPath(session, { id: "silence", originalName: "silence.wav" }, "wav");
      await generateSilenceWav(capturePath, durationSeconds);
      fileName = "generated-silence.wav";
    } else if (request.mode === "audio-file") {
      const asset = this.requireAsset(request.assetId);
      if (asset.kind !== "audio") {
        throw new HttpError(400, "INVALID_ASSET_KIND", "Mic audio-file mode requires an audio asset");
      }
      capturePath = this.derivedPath(session, asset, "wav");
      await normalizeAudioToWav(asset.path, capturePath, {
        loop: request.loop ?? false,
        durationSeconds: request.loop ? durationSeconds : undefined
      });
      fileName = asset.originalName;
      assetId = asset.id;
    } else {
      if (!request.text?.trim()) {
        throw new HttpError(400, "TTS_TEXT_REQUIRED", "Mic TTS mode requires a non-empty text field");
      }
      capturePath = this.derivedPath(session, { id: "tts", originalName: "tts.wav" }, "wav");
      await synthesizeSpeechWithEspeak({ text: request.text, outputPath: capturePath, voice: request.voice });
      fileName = "generated-tts.wav";
      voice = request.voice || "default";
    }

    session.media.mic = {
      mode: request.mode,
      assetId,
      loop: request.loop ?? false,
      active: true,
      fileName,
      voice,
      capturePath,
      implementation: "Chromium --use-file-for-fake-audio-capture plus silence Web Audio fallback",
      notes: [
        "Chromium fake audio file support varies by platform and browser build.",
        "For production-grade live mic routing, use host-level PulseAudio or PipeWire virtual devices."
      ]
    };
    await this.restartBrowser(session);
    return this.toStatus(session);
  }

  private async cleanupExpired(): Promise<void> {
    const now = Date.now();
    const expired = [...this.sessions.values()].filter((session) => session.expiresAt.getTime() <= now);
    await Promise.all(expired.map((session) => this.deleteSession(session.id).catch(() => undefined)));
  }

  private requireSession(id: string): ManagedSession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new HttpError(404, "SESSION_NOT_FOUND", `No active session with id ${id}`);
    }
    return session;
  }

  private requireAsset(assetId: string | undefined): StoredAssetMetadata {
    if (!assetId) {
      throw new HttpError(400, "ASSET_ID_REQUIRED", "assetId is required");
    }
    const asset = this.assets.get(assetId);
    if (!asset) {
      throw new HttpError(404, "ASSET_NOT_FOUND", `No asset with id ${assetId}`);
    }
    return asset;
  }

  private async requirePage(session: ManagedSession): Promise<Page> {
    if (!session.page || session.page.isClosed()) {
      await this.launchBrowser(session);
    }
    if (!session.page) {
      throw new HttpError(500, "PAGE_UNAVAILABLE", "Browser page is unavailable");
    }
    return session.page;
  }

  private derivedPath(
    session: ManagedSession,
    asset: Pick<StoredAssetMetadata, "id" | "originalName">,
    extension: string
  ): string {
    const safeStem = asset.originalName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "media";
    return path.join(this.config.dataDir, "derived", session.id, `${Date.now()}-${asset.id}-${safeStem}.${extension}`);
  }

  private async restartBrowser(session: ManagedSession): Promise<void> {
    const pageUrl = session.page && !session.page.isClosed() ? session.page.url() : session.currentUrl;
    session.currentUrl = pageUrl || "about:blank";
    await this.closeBrowser(session);
    await this.launchBrowser(session);
  }

  private async launchBrowser(session: ManagedSession): Promise<void> {
    await mkdir(path.join(this.config.dataDir, "derived", session.id), { recursive: true });
    const needsFakeDevice = session.media.camera.active || session.media.mic.active;
    const args = [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream"
    ];
    if (needsFakeDevice) {
      args.push("--use-fake-device-for-media-stream");
    }
    if (session.media.camera.capturePath) {
      args.push(`--use-file-for-fake-video-capture=${session.media.camera.capturePath}`);
    }
    if (session.media.mic.capturePath) {
      args.push(`--use-file-for-fake-audio-capture=${session.media.mic.capturePath}`);
    }

    const browser = await chromium.launch({ headless: this.config.headless, args });
    const context = await browser.newContext({
      viewport: this.config.viewport,
      ignoreHTTPSErrors: true
    });
    await context.grantPermissions(["camera", "microphone"]).catch(() => undefined);
    if (session.media.mic.mode === "silence") {
      await context.addInitScript({ content: silenceMicFallbackScript() });
    }
    const page = await context.newPage();
    this.attachPageListeners(session, page);
    session.browser = browser;
    session.context = context;
    session.page = page;
    session.active = true;
    if (session.currentUrl && session.currentUrl !== "about:blank") {
      await page.goto(session.currentUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((error: unknown) => {
        this.pushError(session, error);
      });
    }
    await this.refreshPageMetadata(session).catch(() => undefined);
  }

  private async closeBrowser(session: ManagedSession): Promise<void> {
    session.active = false;
    await session.context?.close().catch(() => undefined);
    await session.browser?.close().catch(() => undefined);
    session.page = undefined;
    session.context = undefined;
    session.browser = undefined;
    this.touch(session);
  }

  private attachPageListeners(session: ManagedSession, page: Page): void {
    page.on("console", (message) => {
      this.pushLog(session, {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        type: message.type(),
        text: message.text().slice(0, 1000),
        location: message.location().url
      });
    });
    page.on("pageerror", (error) => {
      this.pushError(session, error);
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        session.currentUrl = frame.url();
        this.touch(session);
      }
    });
  }

  private async refreshPageMetadata(session: ManagedSession): Promise<void> {
    const page = session.page;
    if (!page || page.isClosed()) {
      return;
    }
    session.currentUrl = page.url();
    session.title = await page.title().catch(() => "");
    this.touch(session);
  }

  private touch(session: ManagedSession): void {
    session.updatedAt = new Date();
  }

  private pushLog(session: ManagedSession, entry: ConsoleLogEntry): void {
    session.consoleLogs.push(entry);
    session.consoleLogs = session.consoleLogs.slice(-100);
    this.touch(session);
  }

  private pushError(session: ManagedSession, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    session.recentErrors.push({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      message: message.slice(0, 1000),
      stack: stack?.slice(0, 4000)
    });
    session.recentErrors = session.recentErrors.slice(-50);
    this.touch(session);
  }

  private publicMedia(session: ManagedSession): MediaStatus {
    const { capturePath: _cameraPath, ...camera } = session.media.camera;
    const { capturePath: _micPath, ...mic } = session.media.mic;
    return { camera, mic };
  }

  private toStatus(session: ManagedSession): BrowserSessionStatus {
    return {
      id: session.id,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      active: session.active,
      currentUrl: session.currentUrl,
      title: session.title,
      media: this.publicMedia(session),
      latestScreenshotDataUrl: session.latestScreenshotDataUrl,
      consoleLogs: [...session.consoleLogs],
      recentErrors: [...session.recentErrors]
    };
  }
}

function silenceMicFallbackScript(): string {
  return `
(() => {
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices || mediaDevices.__telepresenceSilenceInstalled) return;
  const original = mediaDevices.getUserMedia.bind(mediaDevices);
  mediaDevices.getUserMedia = async (constraints = {}) => {
    if (!constraints || !constraints.audio) {
      return original(constraints);
    }
    const videoOnly = constraints.video ? await original({ video: constraints.video, audio: false }) : new MediaStream();
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return videoOnly;
    const context = new AudioContextCtor();
    const destination = context.createMediaStreamDestination();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    gain.gain.value = 0;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    destination.stream.getAudioTracks().forEach((track) => videoOnly.addTrack(track));
    return videoOnly;
  };
  Object.defineProperty(mediaDevices, "__telepresenceSilenceInstalled", { value: true });
})();
`;
}

export function mapExternalToolError(error: unknown): HttpError | undefined {
  if (error instanceof ExternalToolError) {
    return new HttpError(
      503,
      "EXTERNAL_TOOL_UNAVAILABLE",
      `${error.tool} failed or is unavailable. Install ffmpeg and espeak-ng/espeak, or set FFMPEG_PATH/ESPEAK_PATH.`,
      { message: error.message, stderr: error.stderr }
    );
  }
  return undefined;
}

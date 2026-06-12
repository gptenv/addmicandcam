export type CameraMode = "off" | "test-pattern" | "image" | "video" | "generated";

export type MicMode = "off" | "silence" | "audio-file" | "tts" | "stream";

export type AssetKind = "image" | "video" | "audio" | "other";

export type SessionAction =
  | "created"
  | "navigated"
  | "clicked"
  | "typed"
  | "key-pressed"
  | "evaluated"
  | "screenshot"
  | "state"
  | "media-updated"
  | "closed"
  | "error"
  | "moved"
  | "scrolled";

export interface DisclosureConfig {
  enabled: boolean;
  label?: string;
}

export interface CameraSourceConfig {
  mode: CameraMode;
  assetId?: string;
  loop?: boolean;
  active: boolean;
  fileName?: string;
  disclosure?: DisclosureConfig;
  implementation?: string;
  notes?: string[];
}

export interface MicSourceConfig {
  mode: MicMode;
  assetId?: string;
  loop?: boolean;
  active: boolean;
  fileName?: string;
  voice?: string;
  implementation?: string;
  notes?: string[];
}

export interface MediaStatus {
  camera: CameraSourceConfig;
  mic: MicSourceConfig;
}

export interface ConsoleLogEntry {
  id: string;
  timestamp: string;
  type: string;
  text: string;
  location?: string;
}

export interface PageErrorEntry {
  id: string;
  timestamp: string;
  message: string;
  stack?: string;
}

export interface BrowserSessionStatus {
  id: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  active: boolean;
  currentUrl: string;
  title: string;
  media: MediaStatus;
  latestScreenshotDataUrl?: string;
  consoleLogs: ConsoleLogEntry[];
  recentErrors: PageErrorEntry[];
}

export interface AssetMetadata {
  id: string;
  kind: AssetKind;
  originalName: string;
  safeName: string;
  mimeType: string;
  bytes: number;
  createdAt: string;
  url?: string;
  derivedFromAssetId?: string;
}

export interface ElementSummary {
  tag: string;
  role?: string;
  selector: string;
  text?: string;
  href?: string;
  placeholder?: string;
  name?: string;
  type?: string;
  value?: string;
}

export interface PageState {
  sessionId: string;
  currentUrl: string;
  title: string;
  visibleText: string;
  elements: ElementSummary[];
  focusedElement?: ElementSummary;
  consoleLogs: ConsoleLogEntry[];
  recentErrors: PageErrorEntry[];
  media: MediaStatus;
  timestamp: string;
}

export interface PageScrollMetrics {
  scrollX: number;
  scrollY: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  maxScrollX: number;
  maxScrollY: number;
}

export interface CreateSessionResponse {
  session: BrowserSessionStatus;
  urls: {
    web: string;
    lite: string;
    api: string;
    screenshot: string;
    state: string;
  };
}

export interface ApiResult<T = unknown> {
  ok: boolean;
  action?: SessionAction;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface CameraRequest {
  mode: CameraMode;
  assetId?: string;
  loop?: boolean;
  disclosure?: DisclosureConfig;
}

export interface MicRequest {
  mode: MicMode;
  assetId?: string;
  loop?: boolean;
  text?: string;
  voice?: string;
}

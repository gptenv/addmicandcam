import type {
  ApiResult,
  AssetMetadata,
  BrowserSessionStatus,
  CameraMode,
  CreateSessionResponse,
  MicMode,
  PageState
} from "@telepresence/shared";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { apiRequest, assetFileUrl, shortJson } from "./api.js";

type ResultState = ApiResult<unknown> | null;

export default function App() {
  const path = window.location.pathname;
  if (path.startsWith("/session/")) {
    return <SessionPage id={decodeURIComponent(path.split("/")[2] ?? "")} />;
  }
  return <HomePage />;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div>
      <header className="topbar">
        <a id="nav-home" className="brand" href="/">
          LLM Telepresence Browser Lab
        </a>
        <nav aria-label="Main navigation">
          <a id="nav-swagger" href="/swagger">
            Swagger UI
          </a>
          <a id="nav-openapi" href="/openapi.json">
            OpenAPI Spec
          </a>
          <a id="nav-lite" href="/lite">
            Lite
          </a>
        </nav>
      </header>
      <main className="page">{children}</main>
    </div>
  );
}

function HomePage() {
  const [sessions, setSessions] = useState<BrowserSessionStatus[]>([]);
  const [assets, setAssets] = useState<AssetMetadata[]>([]);
  const [result, setResult] = useState<ResultState>(null);
  const [sessionId, setSessionId] = useState("");
  const [url, setUrl] = useState("https://example.com");
  const [ttsText, setTtsText] = useState("Hello, I am testing audio.");

  const refresh = async () => {
    const [sessionResult, assetResult] = await Promise.all([
      apiRequest<BrowserSessionStatus[]>("/api/sessions"),
      apiRequest<AssetMetadata[]>("/api/assets")
    ]);
    if (sessionResult.ok && sessionResult.data) {
      setSessions(sessionResult.data);
      if (!sessionId && sessionResult.data[0]) {
        setSessionId(sessionResult.data[0].id);
      }
    }
    if (assetResult.ok && assetResult.data) {
      setAssets(assetResult.data);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const createSession = async () => {
    const response = await apiRequest<CreateSessionResponse>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({})
    });
    setResult(response);
    if (response.ok && response.data) {
      window.location.href = `/session/${response.data.session.id}`;
    }
  };

  const openExisting = () => {
    if (sessionId.trim()) {
      window.location.href = `/session/${encodeURIComponent(sessionId.trim())}`;
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    const body = new FormData();
    body.set("file", file);
    const response = await apiRequest<AssetMetadata>("/api/assets", { method: "POST", body });
    setResult(response);
    await refresh();
  };

  const navigate = async () => {
    const response = await apiRequest<BrowserSessionStatus>(`/api/sessions/${sessionId}/navigate`, {
      method: "POST",
      body: JSON.stringify({ url })
    });
    setResult(response);
    await refresh();
  };

  const generateTts = async () => {
    const response = await apiRequest<AssetMetadata>("/api/tts", {
      method: "POST",
      body: JSON.stringify({ text: ttsText, voice: "default" })
    });
    setResult(response);
    await refresh();
  };

  const quickAction = async (action: "screenshot" | "state") => {
    const response = await apiRequest(
      `/api/sessions/${sessionId}/${action === "screenshot" ? "screenshot" : "state"}`
    );
    setResult(response);
  };

  return (
    <Shell>
      <section className="hero-panel" aria-labelledby="home-title">
        <div>
          <p className="eyebrow">Authorized testing and demos only</p>
          <h1 id="home-title">Remote browser sessions with synthetic media controls</h1>
          <p>
            Create an isolated Playwright Chromium session, drive it through UI or JSON, and attach disclosed synthetic camera
            or microphone sources for permissioned labs.
          </p>
        </div>
      </section>

      <StatusGrid
        task="Create or attach to a browser session, then upload media and navigate."
        result={result}
        recommendation="Start with Create Session. After upload, open the session page to set camera or mic sources."
      />

      <section className="controls-grid" aria-label="Main controls">
        <Panel title="Session">
          <button id="create-session-button" className="primary" type="button" onClick={createSession}>
            Create Session
          </button>
          <label className="field">
            Existing session id
            <input id="existing-session-id" value={sessionId} onChange={(event) => setSessionId(event.target.value)} />
          </label>
          <button id="open-existing-session-button" type="button" onClick={openExisting}>
            Open Existing Session
          </button>
          <button id="refresh-sessions-button" type="button" onClick={() => void refresh()}>
            Refresh Sessions
          </button>
        </Panel>

        <Panel title="Upload Media">
          <label className="file-button">
            Upload Avatar Image
            <input id="upload-avatar-image" type="file" accept="image/*" onChange={(event) => void upload(event.target.files?.[0])} />
          </label>
          <label className="file-button">
            Upload Avatar Video
            <input id="upload-avatar-video" type="file" accept="video/*" onChange={(event) => void upload(event.target.files?.[0])} />
          </label>
          <label className="file-button">
            Upload Audio
            <input id="upload-audio" type="file" accept="audio/*" onChange={(event) => void upload(event.target.files?.[0])} />
          </label>
          <label className="field">
            TTS text
            <textarea id="tts-text" value={ttsText} onChange={(event) => setTtsText(event.target.value)} />
          </label>
          <button id="generate-tts-audio-button" type="button" onClick={generateTts}>
            Generate TTS Audio
          </button>
        </Panel>

        <Panel title="Quick Actions">
          <label className="field">
            Navigate URL
            <input id="navigate-url" value={url} onChange={(event) => setUrl(event.target.value)} />
          </label>
          <button id="navigate-button" type="button" onClick={navigate} disabled={!sessionId}>
            Navigate
          </button>
          <button id="take-screenshot-button" type="button" onClick={() => void quickAction("screenshot")} disabled={!sessionId}>
            Take Screenshot
          </button>
          <button id="dump-page-state-button" type="button" onClick={() => void quickAction("state")} disabled={!sessionId}>
            Dump Page State
          </button>
          <a id="show-swagger-button" className="button-link" href="/swagger" target="_blank" rel="noopener">
            Swagger UI
          </a>
          <a id="show-openapi-button" className="button-link" href="/openapi.json" target="_blank" rel="noopener">
            OpenAPI Spec (JSON)
          </a>
        </Panel>
      </section>

      <section className="split">
        <Panel title="Active Sessions">
          {sessions.length === 0 ? <p>No sessions yet.</p> : null}
          <ul className="plain-list">
            {sessions.map((session) => (
              <li key={session.id}>
                <a id={`session-link-${session.id}`} href={`/session/${session.id}`}>
                  {session.id}
                </a>
                <span>{session.currentUrl}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Assets">
          {assets.length === 0 ? <p>No uploaded or generated assets yet.</p> : null}
          <ul className="plain-list">
            {assets.map((asset) => (
              <li key={asset.id}>
                <code>{asset.id}</code>
                <span>
                  {asset.kind} · {asset.originalName}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </section>
    </Shell>
  );
}

function SessionPage({ id }: { id: string }) {
  const [status, setStatus] = useState<BrowserSessionStatus | null>(null);
  const [assets, setAssets] = useState<AssetMetadata[]>([]);
  const [pageState, setPageState] = useState<PageState | null>(null);
  const [result, setResult] = useState<ResultState>(null);
  const [url, setUrl] = useState("https://example.com");
  const [selector, setSelector] = useState("body");
  const [typeText, setTypeText] = useState("hello");
  const [key, setKey] = useState("Enter");
  const [script, setScript] = useState("document.title");
  const [cameraMode, setCameraMode] = useState<CameraMode>("test-pattern");
  const [cameraAssetId, setCameraAssetId] = useState("");
  const [micMode, setMicMode] = useState<MicMode>("silence");
  const [micAssetId, setMicAssetId] = useState("");
  const [micText, setMicText] = useState("Hello, I am testing audio.");
  const [disclosureEnabled, setDisclosureEnabled] = useState(true);
  const [disclosureLabel, setDisclosureLabel] = useState("AI-assisted");

  const imageAssets = useMemo(() => assets.filter((asset) => asset.kind === "image"), [assets]);
  const videoAssets = useMemo(() => assets.filter((asset) => asset.kind === "video"), [assets]);
  const audioAssets = useMemo(() => assets.filter((asset) => asset.kind === "audio"), [assets]);
  const cameraAssets = cameraMode === "video" ? videoAssets : imageAssets;

  const refresh = async () => {
    const [sessionResult, assetResult] = await Promise.all([
      apiRequest<BrowserSessionStatus>(`/api/sessions/${id}`),
      apiRequest<AssetMetadata[]>("/api/assets")
    ]);
    if (sessionResult.ok && sessionResult.data) {
      setStatus(sessionResult.data);
    } else {
      setResult(sessionResult);
    }
    if (assetResult.ok && assetResult.data) {
      const nextAssets = assetResult.data;
      setAssets(nextAssets);
      setCameraAssetId((current) => current || nextAssets.find((asset) => asset.kind === "image")?.id || "");
      setMicAssetId((current) => current || nextAssets.find((asset) => asset.kind === "audio")?.id || "");
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [id]);

  const run = async <T,>(request: Promise<ApiResult<T>>) => {
    const response = await request;
    setResult(response as ApiResult<unknown>);
    await refresh();
    return response;
  };

  const takeScreenshot = async () => {
    await run(apiRequest(`/api/sessions/${id}/screenshot`));
  };

  const dumpState = async () => {
    const response = await run(apiRequest<PageState>(`/api/sessions/${id}/state`));
    if (response.ok && response.data) {
      setPageState(response.data);
    }
  };

  const submitNavigate = async (event: FormEvent) => {
    event.preventDefault();
    await run(
      apiRequest(`/api/sessions/${id}/navigate`, {
        method: "POST",
        body: JSON.stringify({ url })
      })
    );
  };

  const submitCamera = async (event: FormEvent) => {
    event.preventDefault();
    await run(
      apiRequest(`/api/sessions/${id}/media/camera`, {
        method: "POST",
        body: JSON.stringify({
          mode: cameraMode,
          assetId: cameraMode === "image" || cameraMode === "video" ? cameraAssetId : undefined,
          loop: true,
          disclosure: { enabled: disclosureEnabled, label: disclosureLabel }
        })
      })
    );
  };

  const submitMic = async (event: FormEvent) => {
    event.preventDefault();
    await run(
      apiRequest(`/api/sessions/${id}/media/mic`, {
        method: "POST",
        body: JSON.stringify({
          mode: micMode,
          assetId: micMode === "audio-file" ? micAssetId : undefined,
          text: micMode === "tts" ? micText : undefined,
          voice: "default",
          loop: false
        })
      })
    );
  };

  return (
    <Shell>
      <section className="session-heading">
        <div>
          <p className="eyebrow">Session</p>
          <h1 id="session-title">{id}</h1>
          <p id="session-current-url">{status?.currentUrl ?? "Loading..."}</p>
        </div>
      </section>

      <StatusGrid
        task={status?.active ? "Browser session is active." : "Browser session is starting or unavailable."}
        result={result}
        recommendation="Use Dump Page State to get selectors, then Click, Type, or Press Key. Set media before opening a camera test page."
      />

      <section className="session-layout">
        <div className="left-column">
          <Panel title="Remote Browser View">
            <div className="button-row">
              <button id="session-screenshot-button" type="button" onClick={takeScreenshot}>
                Take Screenshot
              </button>
              <button id="session-dump-state-button" type="button" onClick={dumpState}>
                Dump Page State
              </button>
              <button id="session-reload-button" type="button" onClick={() => void run(apiRequest(`/api/sessions/${id}/reload`, { method: "POST" }))}>
                Reload
              </button>
              <button id="session-back-button" type="button" onClick={() => void run(apiRequest(`/api/sessions/${id}/back`, { method: "POST" }))}>
                Back
              </button>
              <button id="session-forward-button" type="button" onClick={() => void run(apiRequest(`/api/sessions/${id}/forward`, { method: "POST" }))}>
                Forward
              </button>
            </div>
            {status?.latestScreenshotDataUrl ? (
              <img id="latest-screenshot" className="screenshot" src={status.latestScreenshotDataUrl} alt="Latest browser screenshot" />
            ) : (
              <div className="empty-screenshot" id="latest-screenshot-empty">
                No screenshot yet
              </div>
            )}
          </Panel>

          <Panel title="Page State">
            <pre id="page-state-output">{pageState ? shortJson(pageState) : "Click Dump Page State to inspect selectors and visible text."}</pre>
          </Panel>
        </div>

        <div className="right-column">
          <Panel title="Navigation">
            <form onSubmit={submitNavigate}>
              <label className="field">
                Navigate to URL
                <input id="session-navigate-url" value={url} onChange={(event) => setUrl(event.target.value)} />
              </label>
              <button id="session-navigate-button" className="primary" type="submit">
                Navigate
              </button>
            </form>
          </Panel>

          <Panel title="Interaction">
            <label className="field">
              Selector
              <input id="selector-input" value={selector} onChange={(event) => setSelector(event.target.value)} />
            </label>
            <div className="button-row">
              <button
                id="click-selector-button"
                type="button"
                onClick={() =>
                  void run(apiRequest(`/api/sessions/${id}/click`, { method: "POST", body: JSON.stringify({ selector }) }))
                }
              >
                Click Selector
              </button>
            </div>
            <label className="field">
              Text
              <textarea id="type-text" value={typeText} onChange={(event) => setTypeText(event.target.value)} />
            </label>
            <button
              id="type-into-selector-button"
              type="button"
              onClick={() =>
                void run(
                  apiRequest(`/api/sessions/${id}/type`, {
                    method: "POST",
                    body: JSON.stringify({ selector, text: typeText })
                  })
                )
              }
            >
              Type into Selector
            </button>
            <label className="field">
              Key
              <input id="key-input" value={key} onChange={(event) => setKey(event.target.value)} />
            </label>
            <button
              id="press-key-button"
              type="button"
              onClick={() => void run(apiRequest(`/api/sessions/${id}/key`, { method: "POST", body: JSON.stringify({ key }) }))}
            >
              Press Key
            </button>
            <label className="field">
              Evaluate JS
              <textarea id="evaluate-script" value={script} onChange={(event) => setScript(event.target.value)} />
            </label>
            <button
              id="evaluate-js-button"
              type="button"
              onClick={() =>
                void run(apiRequest(`/api/sessions/${id}/evaluate`, { method: "POST", body: JSON.stringify({ script }) }))
              }
            >
              Evaluate JS
            </button>
          </Panel>

          <Panel title="Synthetic Camera">
            <form onSubmit={submitCamera}>
              <label className="field">
                Camera mode
                <select id="camera-mode" value={cameraMode} onChange={(event) => setCameraMode(event.target.value as CameraMode)}>
                  <option value="test-pattern">test-pattern</option>
                  <option value="image">image</option>
                  <option value="video">video</option>
                  <option value="generated">generated</option>
                  <option value="off">off</option>
                </select>
              </label>
              <label className="field">
                Camera asset
                <select id="camera-asset" value={cameraAssetId} onChange={(event) => setCameraAssetId(event.target.value)}>
                  <option value="">Select asset</option>
                  {cameraAssets.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.kind}: {asset.originalName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="check">
                <input
                  id="camera-disclosure-enabled"
                  type="checkbox"
                  checked={disclosureEnabled}
                  onChange={(event) => setDisclosureEnabled(event.target.checked)}
                />
                Add disclosure watermark
              </label>
              <label className="field">
                Watermark label
                <input id="camera-disclosure-label" value={disclosureLabel} onChange={(event) => setDisclosureLabel(event.target.value)} />
              </label>
              <button id="start-camera-feed-button" className="primary" type="submit">
                Start Camera Feed
              </button>
              <button
                id="stop-camera-feed-button"
                type="button"
                onClick={() =>
                  void run(apiRequest(`/api/sessions/${id}/media/camera`, { method: "POST", body: JSON.stringify({ mode: "off" }) }))
                }
              >
                Stop Camera
              </button>
            </form>
          </Panel>

          <Panel title="Synthetic Microphone">
            <form onSubmit={submitMic}>
              <label className="field">
                Mic mode
                <select id="mic-mode" value={micMode} onChange={(event) => setMicMode(event.target.value as MicMode)}>
                  <option value="silence">silence</option>
                  <option value="audio-file">audio-file</option>
                  <option value="tts">tts</option>
                  <option value="off">off</option>
                </select>
              </label>
              <label className="field">
                Audio asset
                <select id="mic-asset" value={micAssetId} onChange={(event) => setMicAssetId(event.target.value)}>
                  <option value="">Select asset</option>
                  {audioAssets.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.originalName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Speak text using TTS
                <textarea id="mic-tts-text" value={micText} onChange={(event) => setMicText(event.target.value)} />
              </label>
              <button id="start-mic-feed-button" className="primary" type="submit">
                Start Mic Feed
              </button>
              <button
                id="stop-media-button"
                type="button"
                onClick={() =>
                  void Promise.all([
                    run(apiRequest(`/api/sessions/${id}/media/camera`, { method: "POST", body: JSON.stringify({ mode: "off" }) })),
                    run(apiRequest(`/api/sessions/${id}/media/mic`, { method: "POST", body: JSON.stringify({ mode: "off" }) }))
                  ])
                }
              >
                Stop Media
              </button>
            </form>
          </Panel>

          <Panel title="Media Status">
            <pre id="media-status-output">{shortJson(status?.media ?? null)}</pre>
            {audioAssets.length ? (
              <div>
                <h3>Audio Assets</h3>
                {audioAssets.map((asset) => (
                  <audio key={asset.id} id={`audio-${asset.id}`} controls src={assetFileUrl(asset)} />
                ))}
              </div>
            ) : null}
          </Panel>

          <Panel title="Console Logs">
            <pre id="console-log-output">{shortJson(status?.consoleLogs.slice(-20) ?? [])}</pre>
          </Panel>
        </div>
      </section>
    </Shell>
  );
}

function StatusGrid({
  task,
  result,
  recommendation
}: {
  task: string;
  result: ResultState;
  recommendation: string;
}) {
  return (
    <section className="status-grid" aria-label="Agent status">
      <div>
        <h2>Current task status</h2>
        <p id="current-task-status">{task}</p>
      </div>
      <div>
        <h2>Last API result</h2>
        <pre id="last-api-result">{result ? shortJson(result) : "No API call yet."}</pre>
      </div>
      <div>
        <h2>Recommended next actions for agent</h2>
        <p id="recommended-next-actions">{recommendation}</p>
      </div>
    </section>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel" aria-labelledby={`${slug(title)}-title`}>
      <h2 id={`${slug(title)}-title`}>{title}</h2>
      {children}
    </section>
  );
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

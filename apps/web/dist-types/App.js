import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from "react";
import { apiRequest, assetFileUrl, getToken, setToken, shortJson } from "./api.js";
export default function App() {
    const path = window.location.pathname;
    if (path.startsWith("/session/")) {
        return _jsx(SessionPage, { id: decodeURIComponent(path.split("/")[2] ?? "") });
    }
    if (path === "/api-docs") {
        return _jsx(ApiDocsPage, {});
    }
    return _jsx(HomePage, {});
}
function Shell({ children }) {
    return (_jsxs("div", { children: [_jsxs("header", { className: "topbar", children: [_jsx("a", { id: "nav-home", className: "brand", href: "/", children: "LLM Telepresence Browser Lab" }), _jsxs("nav", { "aria-label": "Main navigation", children: [_jsx("a", { id: "nav-api-docs", href: "/api-docs", children: "API Docs" }), _jsx("a", { id: "nav-lite", href: "/lite", children: "Lite" })] })] }), _jsx("main", { className: "page", children: children })] }));
}
function TokenControl() {
    const [value, setValue] = useState(getToken());
    return (_jsxs("label", { className: "field compact", children: ["Admin token", _jsx("input", { id: "admin-token-input", value: value, placeholder: "Optional in local unauthenticated mode", autoComplete: "off", onChange: (event) => {
                    setValue(event.target.value);
                    setToken(event.target.value);
                } })] }));
}
function HomePage() {
    const [sessions, setSessions] = useState([]);
    const [assets, setAssets] = useState([]);
    const [result, setResult] = useState(null);
    const [sessionId, setSessionId] = useState("");
    const [url, setUrl] = useState("https://example.com");
    const [ttsText, setTtsText] = useState("Hello, I am testing audio.");
    const refresh = async () => {
        const [sessionResult, assetResult] = await Promise.all([
            apiRequest("/api/sessions"),
            apiRequest("/api/assets")
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
        const response = await apiRequest("/api/sessions", {
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
    const upload = async (file) => {
        if (!file) {
            return;
        }
        const body = new FormData();
        body.set("file", file);
        const response = await apiRequest("/api/assets", { method: "POST", body });
        setResult(response);
        await refresh();
    };
    const navigate = async () => {
        const response = await apiRequest(`/api/sessions/${sessionId}/navigate`, {
            method: "POST",
            body: JSON.stringify({ url })
        });
        setResult(response);
        await refresh();
    };
    const generateTts = async () => {
        const response = await apiRequest("/api/tts", {
            method: "POST",
            body: JSON.stringify({ text: ttsText, voice: "default" })
        });
        setResult(response);
        await refresh();
    };
    const quickAction = async (action) => {
        const response = await apiRequest(`/api/sessions/${sessionId}/${action === "screenshot" ? "screenshot" : "state"}`);
        setResult(response);
    };
    return (_jsxs(Shell, { children: [_jsxs("section", { className: "hero-panel", "aria-labelledby": "home-title", children: [_jsxs("div", { children: [_jsx("p", { className: "eyebrow", children: "Authorized testing and demos only" }), _jsx("h1", { id: "home-title", children: "Remote browser sessions with synthetic media controls" }), _jsx("p", { children: "Create an isolated Playwright Chromium session, drive it through UI or JSON, and attach disclosed synthetic camera or microphone sources for permissioned labs." })] }), _jsx(TokenControl, {})] }), _jsx(StatusGrid, { task: "Create or attach to a browser session, then upload media and navigate.", result: result, recommendation: "Start with Create Session. After upload, open the session page to set camera or mic sources." }), _jsxs("section", { className: "controls-grid", "aria-label": "Main controls", children: [_jsxs(Panel, { title: "Session", children: [_jsx("button", { id: "create-session-button", className: "primary", type: "button", onClick: createSession, children: "Create Session" }), _jsxs("label", { className: "field", children: ["Existing session id", _jsx("input", { id: "existing-session-id", value: sessionId, onChange: (event) => setSessionId(event.target.value) })] }), _jsx("button", { id: "open-existing-session-button", type: "button", onClick: openExisting, children: "Open Existing Session" }), _jsx("button", { id: "refresh-sessions-button", type: "button", onClick: () => void refresh(), children: "Refresh Sessions" })] }), _jsxs(Panel, { title: "Upload Media", children: [_jsxs("label", { className: "file-button", children: ["Upload Avatar Image", _jsx("input", { id: "upload-avatar-image", type: "file", accept: "image/*", onChange: (event) => void upload(event.target.files?.[0]) })] }), _jsxs("label", { className: "file-button", children: ["Upload Avatar Video", _jsx("input", { id: "upload-avatar-video", type: "file", accept: "video/*", onChange: (event) => void upload(event.target.files?.[0]) })] }), _jsxs("label", { className: "file-button", children: ["Upload Audio", _jsx("input", { id: "upload-audio", type: "file", accept: "audio/*", onChange: (event) => void upload(event.target.files?.[0]) })] }), _jsxs("label", { className: "field", children: ["TTS text", _jsx("textarea", { id: "tts-text", value: ttsText, onChange: (event) => setTtsText(event.target.value) })] }), _jsx("button", { id: "generate-tts-audio-button", type: "button", onClick: generateTts, children: "Generate TTS Audio" })] }), _jsxs(Panel, { title: "Quick Actions", children: [_jsxs("label", { className: "field", children: ["Navigate URL", _jsx("input", { id: "navigate-url", value: url, onChange: (event) => setUrl(event.target.value) })] }), _jsx("button", { id: "navigate-button", type: "button", onClick: navigate, disabled: !sessionId, children: "Navigate" }), _jsx("button", { id: "take-screenshot-button", type: "button", onClick: () => void quickAction("screenshot"), disabled: !sessionId, children: "Take Screenshot" }), _jsx("button", { id: "dump-page-state-button", type: "button", onClick: () => void quickAction("state"), disabled: !sessionId, children: "Dump Page State" }), _jsx("a", { id: "show-api-docs-button", className: "button-link", href: "/api-docs", children: "Show API Docs" })] })] }), _jsxs("section", { className: "split", children: [_jsxs(Panel, { title: "Active Sessions", children: [sessions.length === 0 ? _jsx("p", { children: "No sessions yet." }) : null, _jsx("ul", { className: "plain-list", children: sessions.map((session) => (_jsxs("li", { children: [_jsx("a", { id: `session-link-${session.id}`, href: `/session/${session.id}`, children: session.id }), _jsx("span", { children: session.currentUrl })] }, session.id))) })] }), _jsxs(Panel, { title: "Assets", children: [assets.length === 0 ? _jsx("p", { children: "No uploaded or generated assets yet." }) : null, _jsx("ul", { className: "plain-list", children: assets.map((asset) => (_jsxs("li", { children: [_jsx("code", { children: asset.id }), _jsxs("span", { children: [asset.kind, " \u00B7 ", asset.originalName] })] }, asset.id))) })] })] })] }));
}
function SessionPage({ id }) {
    const [status, setStatus] = useState(null);
    const [assets, setAssets] = useState([]);
    const [pageState, setPageState] = useState(null);
    const [result, setResult] = useState(null);
    const [url, setUrl] = useState("https://example.com");
    const [selector, setSelector] = useState("body");
    const [typeText, setTypeText] = useState("hello");
    const [key, setKey] = useState("Enter");
    const [script, setScript] = useState("document.title");
    const [cameraMode, setCameraMode] = useState("test-pattern");
    const [cameraAssetId, setCameraAssetId] = useState("");
    const [micMode, setMicMode] = useState("silence");
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
            apiRequest(`/api/sessions/${id}`),
            apiRequest("/api/assets")
        ]);
        if (sessionResult.ok && sessionResult.data) {
            setStatus(sessionResult.data);
        }
        else {
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
    const run = async (request) => {
        const response = await request;
        setResult(response);
        await refresh();
        return response;
    };
    const takeScreenshot = async () => {
        await run(apiRequest(`/api/sessions/${id}/screenshot`));
    };
    const dumpState = async () => {
        const response = await run(apiRequest(`/api/sessions/${id}/state`));
        if (response.ok && response.data) {
            setPageState(response.data);
        }
    };
    const submitNavigate = async (event) => {
        event.preventDefault();
        await run(apiRequest(`/api/sessions/${id}/navigate`, {
            method: "POST",
            body: JSON.stringify({ url })
        }));
    };
    const submitCamera = async (event) => {
        event.preventDefault();
        await run(apiRequest(`/api/sessions/${id}/media/camera`, {
            method: "POST",
            body: JSON.stringify({
                mode: cameraMode,
                assetId: cameraMode === "image" || cameraMode === "video" ? cameraAssetId : undefined,
                loop: true,
                disclosure: { enabled: disclosureEnabled, label: disclosureLabel }
            })
        }));
    };
    const submitMic = async (event) => {
        event.preventDefault();
        await run(apiRequest(`/api/sessions/${id}/media/mic`, {
            method: "POST",
            body: JSON.stringify({
                mode: micMode,
                assetId: micMode === "audio-file" ? micAssetId : undefined,
                text: micMode === "tts" ? micText : undefined,
                voice: "default",
                loop: false
            })
        }));
    };
    return (_jsxs(Shell, { children: [_jsxs("section", { className: "session-heading", children: [_jsxs("div", { children: [_jsx("p", { className: "eyebrow", children: "Session" }), _jsx("h1", { id: "session-title", children: id }), _jsx("p", { id: "session-current-url", children: status?.currentUrl ?? "Loading..." })] }), _jsx(TokenControl, {})] }), _jsx(StatusGrid, { task: status?.active ? "Browser session is active." : "Browser session is starting or unavailable.", result: result, recommendation: "Use Dump Page State to get selectors, then Click, Type, or Press Key. Set media before opening a camera test page." }), _jsxs("section", { className: "session-layout", children: [_jsxs("div", { className: "left-column", children: [_jsxs(Panel, { title: "Remote Browser View", children: [_jsxs("div", { className: "button-row", children: [_jsx("button", { id: "session-screenshot-button", type: "button", onClick: takeScreenshot, children: "Take Screenshot" }), _jsx("button", { id: "session-dump-state-button", type: "button", onClick: dumpState, children: "Dump Page State" }), _jsx("button", { id: "session-reload-button", type: "button", onClick: () => void run(apiRequest(`/api/sessions/${id}/reload`, { method: "POST" })), children: "Reload" }), _jsx("button", { id: "session-back-button", type: "button", onClick: () => void run(apiRequest(`/api/sessions/${id}/back`, { method: "POST" })), children: "Back" }), _jsx("button", { id: "session-forward-button", type: "button", onClick: () => void run(apiRequest(`/api/sessions/${id}/forward`, { method: "POST" })), children: "Forward" })] }), status?.latestScreenshotDataUrl ? (_jsx("img", { id: "latest-screenshot", className: "screenshot", src: status.latestScreenshotDataUrl, alt: "Latest browser screenshot" })) : (_jsx("div", { className: "empty-screenshot", id: "latest-screenshot-empty", children: "No screenshot yet" }))] }), _jsx(Panel, { title: "Page State", children: _jsx("pre", { id: "page-state-output", children: pageState ? shortJson(pageState) : "Click Dump Page State to inspect selectors and visible text." }) })] }), _jsxs("div", { className: "right-column", children: [_jsx(Panel, { title: "Navigation", children: _jsxs("form", { onSubmit: submitNavigate, children: [_jsxs("label", { className: "field", children: ["Navigate to URL", _jsx("input", { id: "session-navigate-url", value: url, onChange: (event) => setUrl(event.target.value) })] }), _jsx("button", { id: "session-navigate-button", className: "primary", type: "submit", children: "Navigate" })] }) }), _jsxs(Panel, { title: "Interaction", children: [_jsxs("label", { className: "field", children: ["Selector", _jsx("input", { id: "selector-input", value: selector, onChange: (event) => setSelector(event.target.value) })] }), _jsx("div", { className: "button-row", children: _jsx("button", { id: "click-selector-button", type: "button", onClick: () => void run(apiRequest(`/api/sessions/${id}/click`, { method: "POST", body: JSON.stringify({ selector }) })), children: "Click Selector" }) }), _jsxs("label", { className: "field", children: ["Text", _jsx("textarea", { id: "type-text", value: typeText, onChange: (event) => setTypeText(event.target.value) })] }), _jsx("button", { id: "type-into-selector-button", type: "button", onClick: () => void run(apiRequest(`/api/sessions/${id}/type`, {
                                            method: "POST",
                                            body: JSON.stringify({ selector, text: typeText })
                                        })), children: "Type into Selector" }), _jsxs("label", { className: "field", children: ["Key", _jsx("input", { id: "key-input", value: key, onChange: (event) => setKey(event.target.value) })] }), _jsx("button", { id: "press-key-button", type: "button", onClick: () => void run(apiRequest(`/api/sessions/${id}/key`, { method: "POST", body: JSON.stringify({ key }) })), children: "Press Key" }), _jsxs("label", { className: "field", children: ["Evaluate JS", _jsx("textarea", { id: "evaluate-script", value: script, onChange: (event) => setScript(event.target.value) })] }), _jsx("button", { id: "evaluate-js-button", type: "button", onClick: () => void run(apiRequest(`/api/sessions/${id}/evaluate`, { method: "POST", body: JSON.stringify({ script }) })), children: "Evaluate JS" })] }), _jsx(Panel, { title: "Synthetic Camera", children: _jsxs("form", { onSubmit: submitCamera, children: [_jsxs("label", { className: "field", children: ["Camera mode", _jsxs("select", { id: "camera-mode", value: cameraMode, onChange: (event) => setCameraMode(event.target.value), children: [_jsx("option", { value: "test-pattern", children: "test-pattern" }), _jsx("option", { value: "image", children: "image" }), _jsx("option", { value: "video", children: "video" }), _jsx("option", { value: "generated", children: "generated" }), _jsx("option", { value: "off", children: "off" })] })] }), _jsxs("label", { className: "field", children: ["Camera asset", _jsxs("select", { id: "camera-asset", value: cameraAssetId, onChange: (event) => setCameraAssetId(event.target.value), children: [_jsx("option", { value: "", children: "Select asset" }), cameraAssets.map((asset) => (_jsxs("option", { value: asset.id, children: [asset.kind, ": ", asset.originalName] }, asset.id)))] })] }), _jsxs("label", { className: "check", children: [_jsx("input", { id: "camera-disclosure-enabled", type: "checkbox", checked: disclosureEnabled, onChange: (event) => setDisclosureEnabled(event.target.checked) }), "Add disclosure watermark"] }), _jsxs("label", { className: "field", children: ["Watermark label", _jsx("input", { id: "camera-disclosure-label", value: disclosureLabel, onChange: (event) => setDisclosureLabel(event.target.value) })] }), _jsx("button", { id: "start-camera-feed-button", className: "primary", type: "submit", children: "Start Camera Feed" }), _jsx("button", { id: "stop-camera-feed-button", type: "button", onClick: () => void run(apiRequest(`/api/sessions/${id}/media/camera`, { method: "POST", body: JSON.stringify({ mode: "off" }) })), children: "Stop Camera" })] }) }), _jsx(Panel, { title: "Synthetic Microphone", children: _jsxs("form", { onSubmit: submitMic, children: [_jsxs("label", { className: "field", children: ["Mic mode", _jsxs("select", { id: "mic-mode", value: micMode, onChange: (event) => setMicMode(event.target.value), children: [_jsx("option", { value: "silence", children: "silence" }), _jsx("option", { value: "audio-file", children: "audio-file" }), _jsx("option", { value: "tts", children: "tts" }), _jsx("option", { value: "off", children: "off" })] })] }), _jsxs("label", { className: "field", children: ["Audio asset", _jsxs("select", { id: "mic-asset", value: micAssetId, onChange: (event) => setMicAssetId(event.target.value), children: [_jsx("option", { value: "", children: "Select asset" }), audioAssets.map((asset) => (_jsx("option", { value: asset.id, children: asset.originalName }, asset.id)))] })] }), _jsxs("label", { className: "field", children: ["Speak text using TTS", _jsx("textarea", { id: "mic-tts-text", value: micText, onChange: (event) => setMicText(event.target.value) })] }), _jsx("button", { id: "start-mic-feed-button", className: "primary", type: "submit", children: "Start Mic Feed" }), _jsx("button", { id: "stop-media-button", type: "button", onClick: () => void Promise.all([
                                                run(apiRequest(`/api/sessions/${id}/media/camera`, { method: "POST", body: JSON.stringify({ mode: "off" }) })),
                                                run(apiRequest(`/api/sessions/${id}/media/mic`, { method: "POST", body: JSON.stringify({ mode: "off" }) }))
                                            ]), children: "Stop Media" })] }) }), _jsxs(Panel, { title: "Media Status", children: [_jsx("pre", { id: "media-status-output", children: shortJson(status?.media ?? null) }), audioAssets.length ? (_jsxs("div", { children: [_jsx("h3", { children: "Audio Assets" }), audioAssets.map((asset) => (_jsx("audio", { id: `audio-${asset.id}`, controls: true, src: assetFileUrl(asset) }, asset.id)))] })) : null] }), _jsx(Panel, { title: "Console Logs", children: _jsx("pre", { id: "console-log-output", children: shortJson(status?.consoleLogs.slice(-20) ?? []) }) })] })] })] }));
}
function StatusGrid({ task, result, recommendation }) {
    return (_jsxs("section", { className: "status-grid", "aria-label": "Agent status", children: [_jsxs("div", { children: [_jsx("h2", { children: "Current task status" }), _jsx("p", { id: "current-task-status", children: task })] }), _jsxs("div", { children: [_jsx("h2", { children: "Last API result" }), _jsx("pre", { id: "last-api-result", children: result ? shortJson(result) : "No API call yet." })] }), _jsxs("div", { children: [_jsx("h2", { children: "Recommended next actions for agent" }), _jsx("p", { id: "recommended-next-actions", children: recommendation })] })] }));
}
function Panel({ title, children }) {
    return (_jsxs("section", { className: "panel", "aria-labelledby": `${slug(title)}-title`, children: [_jsx("h2", { id: `${slug(title)}-title`, children: title }), children] }));
}
function ApiDocsPage() {
    return (_jsx(Shell, { children: _jsxs("section", { className: "docs", children: [_jsx("h1", { children: "API Docs" }), _jsxs("p", { children: ["All endpoints return JSON shaped like ", _jsx("code", { children: "{ ok, action, data, error }" }), ". When auth is enabled, send", _jsx("code", { children: " x-admin-token" }), " or ", _jsx("code", { children: "Authorization: Bearer TOKEN" }), "."] }), _jsx("h2", { children: "Create Session" }), _jsx("pre", { children: `curl -s -X POST http://localhost:3000/api/sessions \\
  -H "content-type: application/json" \\
  -H "x-admin-token: $TOKEN" \\
  -d '{}'` }), _jsx("h2", { children: "Navigate" }), _jsx("pre", { children: `curl -s -X POST http://localhost:3000/api/sessions/$SESSION/navigate \\
  -H "content-type: application/json" \\
  -H "x-admin-token: $TOKEN" \\
  -d '{"url":"https://example.com"}'` }), _jsx("h2", { children: "Upload Asset" }), _jsx("pre", { children: `curl -s -X POST http://localhost:3000/api/assets \\
  -H "x-admin-token: $TOKEN" \\
  -F "file=@avatar.png"` }), _jsx("h2", { children: "Set Camera Source" }), _jsx("pre", { children: `curl -s -X POST http://localhost:3000/api/sessions/$SESSION/media/camera \\
  -H "content-type: application/json" \\
  -H "x-admin-token: $TOKEN" \\
  -d '{"mode":"image","assetId":"ASSET","disclosure":{"enabled":true,"label":"AI-assisted"}}'` }), _jsx("h2", { children: "Set Mic Source" }), _jsx("pre", { children: `curl -s -X POST http://localhost:3000/api/sessions/$SESSION/media/mic \\
  -H "content-type: application/json" \\
  -H "x-admin-token: $TOKEN" \\
  -d '{"mode":"tts","text":"Hello, I am testing audio.","voice":"default"}'` }), _jsx("h2", { children: "LLM Usage Loop" }), _jsxs("ol", { children: [_jsxs("li", { children: ["Create a session with ", _jsx("code", { children: "POST /api/sessions" }), "."] }), _jsxs("li", { children: ["Upload approved avatar/audio assets with ", _jsx("code", { children: "POST /api/assets" }), "."] }), _jsx("li", { children: "Set camera or mic sources before visiting WebRTC test pages." }), _jsxs("li", { children: ["Navigate with ", _jsx("code", { children: "/navigate" }), ", inspect ", _jsx("code", { children: "/state" }), ", then use ", _jsx("code", { children: "/click" }), ", ", _jsx("code", { children: "/type" }), ", and ", _jsx("code", { children: "/key" }), "."] }), _jsxs("li", { children: ["Close the session with ", _jsx("code", { children: "DELETE /api/sessions/:id" }), "."] })] }), _jsx("h2", { children: "Safety Notes" }), _jsx("p", { children: "This lab is for explicit-consent scenarios only. It does not implement stealth, CAPTCHA bypass, credential theft, or platform abuse features. Keep synthetic media disclosure enabled when participants should know media is generated." })] }) }));
}
function slug(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

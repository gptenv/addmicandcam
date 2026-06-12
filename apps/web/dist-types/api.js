export async function apiRequest(path, init = {}) {
    const headers = new Headers(init.headers);
    if (init.body && !(init.body instanceof FormData) && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
    }
    const response = await fetch(path, { ...init, headers });
    const text = await response.text();
    let parsed;
    try {
        parsed = text ? JSON.parse(text) : { ok: response.ok };
    }
    catch {
        parsed = response.ok
            ? { ok: true, data: text }
            : { ok: false, error: { code: "HTTP_ERROR", message: text || response.statusText } };
    }
    if (!response.ok && parsed.ok) {
        return { ok: false, error: { code: "HTTP_ERROR", message: response.statusText } };
    }
    return parsed;
}
export function assetFileUrl(asset) {
    return asset.url ?? `/api/assets/${asset.id}/file`;
}
export function shortJson(value) {
    return JSON.stringify(value, null, 2);
}

const TOKEN_KEY = "telepresence-admin-token";
export function getToken() {
    return localStorage.getItem(TOKEN_KEY) ?? "";
}
export function setToken(token) {
    if (token.trim()) {
        localStorage.setItem(TOKEN_KEY, token.trim());
    }
    else {
        localStorage.removeItem(TOKEN_KEY);
    }
}
export async function apiRequest(path, init = {}) {
    const headers = new Headers(init.headers);
    const token = getToken();
    if (token) {
        headers.set("x-admin-token", token);
    }
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
    const token = getToken();
    const url = asset.url ?? `/api/assets/${asset.id}/file`;
    return token ? `${url}?token=${encodeURIComponent(token)}` : url;
}
export function shortJson(value) {
    return JSON.stringify(value, null, 2);
}

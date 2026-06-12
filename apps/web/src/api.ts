import type { ApiResult, AssetMetadata } from "@telepresence/shared";

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  let parsed: ApiResult<T>;
  try {
    parsed = text ? (JSON.parse(text) as ApiResult<T>) : ({ ok: response.ok } as ApiResult<T>);
  } catch {
    parsed = response.ok
      ? ({ ok: true, data: text as T } as ApiResult<T>)
      : { ok: false, error: { code: "HTTP_ERROR", message: text || response.statusText } };
  }

  if (!response.ok && parsed.ok) {
    return { ok: false, error: { code: "HTTP_ERROR", message: response.statusText } };
  }
  return parsed;
}

export function assetFileUrl(asset: AssetMetadata): string {
  return asset.url ?? `/api/assets/${asset.id}/file`;
}

export function shortJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

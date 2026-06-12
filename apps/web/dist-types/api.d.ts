import type { ApiResult, AssetMetadata } from "@telepresence/shared";
export declare function apiRequest<T>(path: string, init?: RequestInit): Promise<ApiResult<T>>;
export declare function assetFileUrl(asset: AssetMetadata): string;
export declare function shortJson(value: unknown): string;
//# sourceMappingURL=api.d.ts.map
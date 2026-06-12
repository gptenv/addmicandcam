import type { AssetKind, AssetMetadata } from "@telepresence/shared";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";

export interface IncomingUpload {
  filename: string;
  mimetype: string;
  file: NodeJS.ReadableStream;
}

export interface StoredAssetMetadata extends AssetMetadata {
  path: string;
}

export class AssetStore {
  private readonly assets = new Map<string, StoredAssetMetadata>();
  private readonly assetDir: string;
  private readonly generatedDir: string;
  private readonly indexPath: string;

  constructor(private readonly dataDir: string) {
    this.assetDir = path.join(dataDir, "assets");
    this.generatedDir = path.join(dataDir, "generated-assets");
    this.indexPath = path.join(dataDir, "assets.json");
  }

  async init(): Promise<void> {
    await mkdir(this.assetDir, { recursive: true });
    await mkdir(this.generatedDir, { recursive: true });
    try {
      const raw = await readFile(this.indexPath, "utf8");
      const records = JSON.parse(raw) as StoredAssetMetadata[];
      for (const record of records) {
        this.assets.set(record.id, record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  list(): AssetMetadata[] {
    return [...this.assets.values()].map((asset) => this.toPublicMetadata(asset));
  }

  get(id: string): StoredAssetMetadata | undefined {
    return this.assets.get(id);
  }

  getPublic(id: string): AssetMetadata | undefined {
    const asset = this.assets.get(id);
    return asset ? this.toPublicMetadata(asset) : undefined;
  }

  createReadStream(id: string): NodeJS.ReadableStream | undefined {
    const asset = this.assets.get(id);
    return asset ? createReadStream(asset.path) : undefined;
  }

  async createFromUpload(upload: IncomingUpload): Promise<AssetMetadata> {
    const id = randomUUID();
    const safeName = `${id}-${sanitizeFilename(upload.filename || "upload.bin")}`;
    const filePath = path.join(this.assetDir, safeName);
    await pipeline(upload.file, createWriteStream(filePath, { flags: "wx" }));
    const fileStat = await stat(filePath);
    const metadata: StoredAssetMetadata = {
      id,
      kind: kindFromMime(upload.mimetype, upload.filename),
      originalName: upload.filename || "upload.bin",
      safeName,
      mimeType: upload.mimetype || "application/octet-stream",
      bytes: fileStat.size,
      createdAt: new Date().toISOString(),
      path: filePath,
      url: `/api/assets/${id}/file`
    };
    this.assets.set(id, metadata);
    await this.save();
    return this.toPublicMetadata(metadata);
  }

  reserveGeneratedPath(extension: string): { id: string; filePath: string } {
    const id = randomUUID();
    const cleanExtension = extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
    return { id, filePath: path.join(this.generatedDir, `${id}.${cleanExtension}`) };
  }

  async registerGeneratedAsset(input: {
    id: string;
    filePath: string;
    kind: AssetKind;
    mimeType: string;
    originalName: string;
    derivedFromAssetId?: string;
  }): Promise<AssetMetadata> {
    const fileStat = await stat(input.filePath);
    const metadata: StoredAssetMetadata = {
      id: input.id,
      kind: input.kind,
      originalName: input.originalName,
      safeName: path.basename(input.filePath),
      mimeType: input.mimeType,
      bytes: fileStat.size,
      createdAt: new Date().toISOString(),
      path: input.filePath,
      url: `/api/assets/${input.id}/file`,
      derivedFromAssetId: input.derivedFromAssetId
    };
    this.assets.set(input.id, metadata);
    await this.save();
    return this.toPublicMetadata(metadata);
  }

  private toPublicMetadata(asset: StoredAssetMetadata): AssetMetadata {
    const { path: _path, ...publicAsset } = asset;
    return publicAsset;
  }

  private async save(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const tmpPath = `${this.indexPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify([...this.assets.values()], null, 2));
    await rename(tmpPath, this.indexPath);
  }
}

export function sanitizeFilename(filename: string): string {
  const base = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.slice(0, 120) || "upload.bin";
}

export function kindFromMime(mimeType: string, filename = ""): AssetKind {
  const mime = mimeType.toLowerCase();
  const ext = path.extname(filename).toLowerCase();
  if (mime.startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
    return "image";
  }
  if (mime.startsWith("video/") || [".mp4", ".mov", ".webm", ".mkv"].includes(ext)) {
    return "video";
  }
  if (mime.startsWith("audio/") || [".wav", ".mp3", ".ogg", ".opus", ".m4a", ".flac"].includes(ext)) {
    return "audio";
  }
  return "other";
}

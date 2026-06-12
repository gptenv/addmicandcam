import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export interface VideoOptions {
  width?: number;
  height?: number;
  fps?: number;
  durationSeconds?: number;
  loop?: boolean;
  overlay?: {
    enabled: boolean;
    label?: string;
    sessionId?: string;
  };
}

export interface AudioOptions {
  durationSeconds?: number;
  loop?: boolean;
}

export interface TtsOptions {
  text: string;
  outputPath: string;
  voice?: string;
}

export class ExternalToolError extends Error {
  constructor(
    message: string,
    public readonly tool: string,
    public readonly code?: number | null,
    public readonly stderr?: string
  ) {
    super(message);
    this.name = "ExternalToolError";
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
}

function truthy(value: string | undefined): value is string {
  return Boolean(value && value.trim().length > 0);
}

async function runProcess(command: string, args: string[], timeoutMs = 120_000): Promise<RunResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ExternalToolError(`${command} timed out`, command, null, stderr));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ExternalToolError(`${command} is not available: ${error.message}`, command, null, stderr));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new ExternalToolError(`${command} exited with code ${code}`, command, code, stderr));
    });
  });
}

async function firstWorkingCommand(candidates: string[], probeArgs: string[]): Promise<string> {
  for (const candidate of candidates.filter(truthy)) {
    try {
      await runProcess(candidate, probeArgs, 10_000);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new ExternalToolError(
    `None of these commands are available: ${candidates.filter(truthy).join(", ")}`,
    candidates[0] ?? "unknown"
  );
}

export async function resolveFfmpeg(): Promise<string> {
  return firstWorkingCommand([process.env.FFMPEG_PATH ?? "", "ffmpeg"], ["-version"]);
}

export async function resolveEspeak(): Promise<string> {
  return firstWorkingCommand([process.env.ESPEAK_PATH ?? "", "espeak-ng", "espeak"], ["--version"]);
}

function ffmpegEscapeDrawtext(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

export function buildVideoFilter(options: VideoOptions = {}): string {
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const parts = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    "setsar=1",
    "format=yuv420p"
  ];

  if (options.overlay?.enabled) {
    const labelParts = [options.overlay.label || "AI-assisted", options.overlay.sessionId].filter(Boolean);
    const label = ffmpegEscapeDrawtext(labelParts.join(" "));
    parts.push(
      `drawtext=text='${label}':x=24:y=h-th-24:fontsize=32:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=12`
    );
  }

  return parts.join(",");
}

export async function imageToY4M(inputPath: string, outputPath: string, options: VideoOptions = {}): Promise<string> {
  const ffmpeg = await resolveFfmpeg();
  await mkdir(path.dirname(outputPath), { recursive: true });
  const duration = String(options.durationSeconds ?? 12);
  const fps = String(options.fps ?? 30);
  await runProcess(ffmpeg, [
    "-y",
    "-loop",
    "1",
    "-i",
    inputPath,
    "-t",
    duration,
    "-vf",
    buildVideoFilter(options),
    "-r",
    fps,
    "-an",
    "-pix_fmt",
    "yuv420p",
    "-f",
    "yuv4mpegpipe",
    outputPath
  ]);
  return outputPath;
}

export async function videoToY4M(inputPath: string, outputPath: string, options: VideoOptions = {}): Promise<string> {
  const ffmpeg = await resolveFfmpeg();
  await mkdir(path.dirname(outputPath), { recursive: true });
  const duration = String(options.durationSeconds ?? 12);
  const fps = String(options.fps ?? 30);
  const args = ["-y"];
  if (options.loop ?? true) {
    args.push("-stream_loop", "-1");
  }
  args.push(
    "-i",
    inputPath,
    "-t",
    duration,
    "-vf",
    buildVideoFilter(options),
    "-r",
    fps,
    "-an",
    "-pix_fmt",
    "yuv420p",
    "-f",
    "yuv4mpegpipe",
    outputPath
  );
  await runProcess(ffmpeg, args);
  return outputPath;
}

export async function normalizeAudioToWav(inputPath: string, outputPath: string, options: AudioOptions = {}): Promise<string> {
  const ffmpeg = await resolveFfmpeg();
  await mkdir(path.dirname(outputPath), { recursive: true });
  const args = ["-y"];
  if (options.loop) {
    args.push("-stream_loop", "-1");
  }
  args.push("-i", inputPath);
  if (options.durationSeconds) {
    args.push("-t", String(options.durationSeconds));
  }
  args.push("-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", outputPath);
  await runProcess(ffmpeg, args);
  return outputPath;
}

export async function generateSilenceWav(outputPath: string, durationSeconds = 12): Promise<string> {
  const ffmpeg = await resolveFfmpeg();
  await mkdir(path.dirname(outputPath), { recursive: true });
  await runProcess(ffmpeg, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=mono",
    "-t",
    String(durationSeconds),
    "-c:a",
    "pcm_s16le",
    outputPath
  ]);
  return outputPath;
}

export async function synthesizeSpeechWithEspeak(options: TtsOptions): Promise<string> {
  if (!options.text.trim()) {
    throw new ExternalToolError("TTS text cannot be empty", "espeak");
  }
  const espeak = await resolveEspeak();
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  const voice = options.voice && options.voice !== "default" ? options.voice : undefined;
  const args = ["-w", options.outputPath];
  if (voice) {
    args.push("-v", voice);
  }
  args.push(options.text);
  await runProcess(espeak, args, 60_000);
  return options.outputPath;
}

export async function probeMediaTools(): Promise<{ ffmpeg: boolean; espeak: boolean; errors: string[] }> {
  const errors: string[] = [];
  let ffmpeg = false;
  let espeak = false;
  try {
    await resolveFfmpeg();
    ffmpeg = true;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    await resolveEspeak();
    espeak = true;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { ffmpeg, espeak, errors };
}

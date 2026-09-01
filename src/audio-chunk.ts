import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Tunables (env-overridable) ──────────────────────────────────────────────

/**
 * Hard cap (ms) for a single VK voice message. VK rejects voice notes longer
 * than ~5 minutes; we leave a safety margin (4.5 min default).
 */
export function getVkAudioMessageMaxMs(): number {
  return readPositiveIntEnv("VK_AUDIO_MESSAGE_MAX_MS", 270_000);
}

function getAudioSplitTimeoutMs(): number {
  return readPositiveIntEnv("VK_AUDIO_SPLIT_TIMEOUT_MS", 120_000);
}

function getFfprobeBin(): string {
  return process.env.FFPROBE_BIN?.trim() || "ffprobe";
}

function getFfmpegBin(): string {
  return process.env.FFMPEG_BIN?.trim() || "ffmpeg";
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ── Process helper ──────────────────────────────────────────────────────────

type ExecResult = { stdout: string; stderr: string };

function runProcess(bin: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: getAudioSplitTimeoutMs(), maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // Attach captured stderr for debugging but still reject.
          (error as Error & { stderr?: string }).stderr = String(stderr ?? "");
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

// ── Duration probe ──────────────────────────────────────────────────────────

/**
 * Returns container duration in milliseconds, or null if it could not be
 * determined (missing ffprobe, unreadable file, etc.). Never throws.
 */
export async function probeAudioDurationMs(file: string): Promise<number | null> {
  try {
    const { stdout } = await runProcess(getFfprobeBin(), [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      file,
    ]);
    const seconds = Number.parseFloat(stdout.trim());
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return null;
    }
    return Math.round(seconds * 1000);
  } catch {
    return null;
  }
}

// ── Silence detection + cut-point selection ─────────────────────────────────

type SilenceWindow = { start: number; end: number };

/**
 * Parses `silence_start` / `silence_end` pairs (seconds) out of ffmpeg's
 * `silencedetect` stderr output.
 */
export function parseSilenceWindows(stderr: string): SilenceWindow[] {
  const windows: SilenceWindow[] = [];
  let pendingStart: number | null = null;
  const startRe = /silence_start:\s*([0-9]+(?:\.[0-9]+)?)/;
  const endRe = /silence_end:\s*([0-9]+(?:\.[0-9]+)?)/;

  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = startRe.exec(line);
    if (startMatch) {
      pendingStart = Number.parseFloat(startMatch[1] as string);
      continue;
    }
    const endMatch = endRe.exec(line);
    if (endMatch) {
      const end = Number.parseFloat(endMatch[1] as string);
      const start = pendingStart ?? Math.max(0, end);
      if (Number.isFinite(end)) {
        windows.push({ start: Number.isFinite(start) ? start : Math.max(0, end), end });
      }
      pendingStart = null;
    }
  }
  return windows;
}

/**
 * Greedily picks cut boundaries (in ms) so each segment is ≤ maxMs.
 * For each window we prefer the LAST silence boundary that still fits under
 * maxMs from the current segment start. The midpoint of a silence window is
 * used as the actual cut so the gap is split between both segments.
 * If no silence fits, we cut hard at maxMs.
 *
 * Returns ordered boundaries strictly between 0 and totalMs (exclusive).
 */
export function selectCutPointsMs(
  silenceWindows: SilenceWindow[],
  totalMs: number,
  maxMs: number,
): number[] {
  const boundaries: number[] = [];
  if (totalMs <= maxMs || maxMs <= 0) {
    return boundaries;
  }

  // Candidate cut points (ms): midpoint of each silence window, sorted.
  const candidates = silenceWindows
    .map((w) => Math.round(((w.start + w.end) / 2) * 1000))
    .filter((ms) => Number.isFinite(ms) && ms > 0 && ms < totalMs)
    .sort((a, b) => a - b);

  let segmentStart = 0;
  while (totalMs - segmentStart > maxMs) {
    const limit = segmentStart + maxMs;
    // Last candidate strictly within (segmentStart, limit].
    let chosen: number | null = null;
    for (const candidate of candidates) {
      if (candidate <= segmentStart) {
        continue;
      }
      if (candidate <= limit) {
        chosen = candidate;
      } else {
        break;
      }
    }
    const cut = chosen ?? limit;
    // Guard against zero-length / non-advancing segments.
    if (cut <= segmentStart) {
      boundaries.push(limit);
      segmentStart = limit;
      continue;
    }
    boundaries.push(cut);
    segmentStart = cut;
  }
  return boundaries;
}

// ── Segment extraction ──────────────────────────────────────────────────────

function fileExtension(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : ".ogg";
}

/**
 * Splits `file` at silence into ≤ maxMs segments. Returns absolute paths of the
 * produced temp files (in os.tmpdir()), or an empty array on any failure / when
 * no split is needed. The caller is responsible for deleting the returned files
 * AND their parent directory (use `cleanupAudioSegments`).
 *
 * Segments keep the input container/codec via `-c copy` (stream copy). Stream
 * copy can only cut on keyframes, so the actual boundaries may drift slightly
 * from the requested cut points — acceptable for voice.
 */
export async function splitAudioAtSilence(file: string, maxMs: number): Promise<string[]> {
  if (!file || maxMs <= 0) {
    return [];
  }

  let totalMs: number | null;
  try {
    totalMs = await probeAudioDurationMs(file);
  } catch {
    return [];
  }
  if (totalMs === null || totalMs <= maxMs) {
    return [];
  }

  let silenceStderr = "";
  try {
    const result = await runProcess(getFfmpegBin(), [
      "-hide_banner",
      "-nostats",
      "-i",
      file,
      "-af",
      "silencedetect=noise=-30dB:d=0.4",
      "-f",
      "null",
      "-",
    ]);
    silenceStderr = result.stderr;
  } catch (error) {
    silenceStderr = String((error as { stderr?: string }).stderr ?? "");
  }

  const windows = parseSilenceWindows(silenceStderr);
  const cutPoints = selectCutPointsMs(windows, totalMs, maxMs);
  if (cutPoints.length === 0) {
    return [];
  }

  // Build [start, end) ranges in ms.
  const ranges: Array<{ start: number; end: number }> = [];
  let prev = 0;
  for (const cut of cutPoints) {
    ranges.push({ start: prev, end: cut });
    prev = cut;
  }
  ranges.push({ start: prev, end: totalMs });

  if (ranges.length < 2) {
    return [];
  }

  const ext = fileExtension(file);
  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), "vk-voice-"));
  } catch {
    return [];
  }

  const outputs: string[] = [];
  try {
    for (let index = 0; index < ranges.length; index += 1) {
      const range = ranges[index] as { start: number; end: number };
      const out = join(dir, `part-${String(index).padStart(3, "0")}${ext}`);
      const startSec = (range.start / 1000).toFixed(3);
      const args = [
        "-y",
        "-hide_banner",
        "-nostats",
        "-ss",
        startSec,
        "-i",
        file,
      ];
      // Last range runs to EOF; intermediate ranges get an explicit duration.
      if (index < ranges.length - 1) {
        const durSec = ((range.end - range.start) / 1000).toFixed(3);
        args.push("-t", durSec);
      }
      args.push("-c", "copy", out);
      await runProcess(getFfmpegBin(), args);
      outputs.push(out);
    }
  } catch {
    // Any extraction failure → clean up and bail so caller falls back. When the
    // first extraction fails, `outputs` is empty, so cleanupAudioSegments can't
    // derive the temp dir — remove it explicitly so the mkdtemp dir (and any
    // partial file) never leaks.
    await cleanupAudioSegments(outputs);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return [];
  }

  if (outputs.length < 2) {
    // Not enough segments to be worth splitting. Same leak guard: with zero
    // outputs the dir must be removed explicitly.
    await cleanupAudioSegments(outputs);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return [];
  }
  return outputs;
}

/**
 * Removes generated segment temp files and their parent dir. Never throws.
 */
export async function cleanupAudioSegments(files: readonly string[]): Promise<void> {
  const dirs = new Set<string>();
  for (const file of files) {
    if (!file) {
      continue;
    }
    const dir = file.slice(0, Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")));
    if (dir) {
      dirs.add(dir);
    }
    await rm(file, { force: true }).catch(() => {});
  }
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  getVkAudioMessageMaxMs,
  parseSilenceWindows,
  probeAudioDurationMs,
  selectCutPointsMs,
  splitAudioAtSilence,
} from "./audio-chunk.js";

/**
 * Makes the mocked execFile resolve with the given stdout/stderr by invoking
 * its node-style callback (last argument).
 */
function stubExecFile(stdout: string, stderr = ""): void {
  mockExecFile.mockImplementation((_bin, _args, _opts, cb) => {
    cb(null, stdout, stderr);
  });
}

function stubExecFileError(message: string, stderr = ""): void {
  mockExecFile.mockImplementation((_bin, _args, _opts, cb) => {
    const error = new Error(message) as Error & { stderr?: string };
    error.stderr = stderr;
    cb(error, "", stderr);
  });
}

beforeEach(() => {
  mockExecFile.mockReset();
  delete process.env.VK_AUDIO_MESSAGE_MAX_MS;
  delete process.env.FFPROBE_BIN;
  delete process.env.FFMPEG_BIN;
});

describe("getVkAudioMessageMaxMs", () => {
  it("defaults to 270000 ms (4.5 min)", () => {
    expect(getVkAudioMessageMaxMs()).toBe(270_000);
  });

  it("honors VK_AUDIO_MESSAGE_MAX_MS env override", () => {
    process.env.VK_AUDIO_MESSAGE_MAX_MS = "60000";
    expect(getVkAudioMessageMaxMs()).toBe(60_000);
  });

  it("ignores invalid env values", () => {
    process.env.VK_AUDIO_MESSAGE_MAX_MS = "not-a-number";
    expect(getVkAudioMessageMaxMs()).toBe(270_000);
  });
});

describe("probeAudioDurationMs", () => {
  it("parses ffprobe duration seconds into ms", async () => {
    stubExecFile("123.456\n");
    await expect(probeAudioDurationMs("/tmp/a.ogg")).resolves.toBe(123_456);
  });

  it("returns null when ffprobe output is not a positive number", async () => {
    stubExecFile("N/A\n");
    await expect(probeAudioDurationMs("/tmp/a.ogg")).resolves.toBeNull();
  });

  it("returns null (never throws) when ffprobe fails", async () => {
    stubExecFileError("ffprobe not found");
    await expect(probeAudioDurationMs("/tmp/a.ogg")).resolves.toBeNull();
  });
});

describe("parseSilenceWindows", () => {
  it("pairs silence_start with silence_end", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: 10.5",
      "[silencedetect @ 0x1] silence_end: 11.2 | silence_duration: 0.7",
      "[silencedetect @ 0x1] silence_start: 250.0",
      "[silencedetect @ 0x1] silence_end: 251.0 | silence_duration: 1.0",
    ].join("\n");
    expect(parseSilenceWindows(stderr)).toEqual([
      { start: 10.5, end: 11.2 },
      { start: 250.0, end: 251.0 },
    ]);
  });

  it("returns empty for output with no silence", () => {
    expect(parseSilenceWindows("nothing here")).toEqual([]);
  });
});

describe("selectCutPointsMs", () => {
  it("returns no cuts when total ≤ max", () => {
    expect(selectCutPointsMs([], 100_000, 270_000)).toEqual([]);
  });

  it("prefers the last silence midpoint before the max boundary", () => {
    // total 600s, max 270s. Silence windows at 100s, 260s, 280s.
    const windows = [
      { start: 100, end: 100.5 },
      { start: 260, end: 260.5 },
      { start: 280, end: 280.5 },
    ];
    const cuts = selectCutPointsMs(windows, 600_000, 270_000);
    // First cut: last silence ≤ 270s → midpoint of 260..260.5 = 260250 ms.
    expect(cuts[0]).toBe(260_250);
    // Every segment must be ≤ max.
    let prev = 0;
    for (const cut of cuts) {
      expect(cut - prev).toBeLessThanOrEqual(270_000);
      prev = cut;
    }
    expect(600_000 - prev).toBeLessThanOrEqual(270_000);
  });

  it("cuts hard at max when no silence fits in the window", () => {
    const cuts = selectCutPointsMs([], 600_000, 270_000);
    expect(cuts).toEqual([270_000, 540_000]);
  });
});

describe("splitAudioAtSilence temp dir cleanup", () => {
  async function vkVoiceDirs(): Promise<string[]> {
    const entries = await readdir(tmpdir());
    return entries.filter((e) => e.startsWith("vk-voice-")).sort();
  }

  it("removes the temp dir when the first ffmpeg extraction fails", async () => {
    // Regression guard for finding #3: on the first-segment failure `outputs`
    // is empty, so cleanupAudioSegments can't derive the mkdtemp dir — it must
    // be removed explicitly or the vk-voice-* dir (and a partial file) leaks.
    const before = await vkVoiceDirs();

    mockExecFile.mockImplementation(
      (
        _bin: string,
        args: string[],
        _opts: unknown,
        cb: (e: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const a = args.join(" ");
        if (a.includes("format=duration")) {
          cb(null, "100.0\n", ""); // 100s >> maxMs → will split
        } else if (a.includes("silencedetect")) {
          cb(null, "", ""); // no silence → even cuts by maxMs still apply
        } else {
          // extraction of the very first segment fails
          const err = Object.assign(new Error("ffmpeg boom"), { stderr: "boom" });
          cb(err, "", "boom");
        }
      },
    );

    const result = await splitAudioAtSilence("/tmp/in.ogg", 40_000);
    expect(result).toEqual([]);
    expect(await vkVoiceDirs()).toEqual(before); // no leaked vk-voice-* dir
  });
});

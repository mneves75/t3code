import { describe, expect, it } from "@effect/vitest";

import {
  createMlxMetricParserState,
  isMetalOomLine,
  parseMlxLoraLine,
  stripAnsi,
} from "./MlxLoraMetricParser.ts";

const AT = "2026-11-24T21:00:00.000Z";

describe("MlxLoraMetricParser", () => {
  it("parses ANSI-colored mlx_lm 0.32.2 Rich TrainUI train and validation rows with RSS peak memory and ETA", () => {
    const state = createMlxMetricParserState(100);

    const first = parseMlxLoraLine(
      "\u001b[38;2;120;200;120m  10    1.842 ▼    1,420     4.2k\u001b[0m",
      state,
      { nowMs: 1_000, recordedAt: AT, sampledPeakMemGb: 8.5 },
    );
    expect(first).toEqual({
      kind: "metric",
      tick: {
        iter: 10,
        totalIters: 100,
        trainLoss: 1.842,
        tokSec: 1420,
        trainedTokens: 4200,
        peakMemGb: 8.5,
        recordedAt: AT,
      },
    });

    const second = parseMlxLoraLine("\u001b[1m  20    1.610 ▲    1,650.5    8.4k\u001b[0m", state, {
      nowMs: 6_000,
      recordedAt: AT,
      sampledPeakMemGb: 7.9,
    });
    expect(second).toEqual({
      kind: "metric",
      tick: {
        iter: 20,
        totalIters: 100,
        trainLoss: 1.61,
        tokSec: 1650.5,
        trainedTokens: 8400,
        itSec: 2,
        etaSec: 40,
        // Monotonic max across samples
        peakMemGb: 8.5,
        recordedAt: AT,
      },
    });

    const val = parseMlxLoraLine("  20    val 1.512    3.42s", state, {
      nowMs: 9_420,
      recordedAt: AT,
      sampledPeakMemGb: 9.125,
    });
    expect(val).toEqual({
      kind: "metric",
      tick: {
        iter: 20,
        totalIters: 100,
        valLoss: 1.512,
        peakMemGb: 9.125,
        recordedAt: AT,
      },
    });
  });

  it("parses legacy mlx_lm < 0.30 train and validation rows", () => {
    const state = createMlxMetricParserState(200);
    const train = parseMlxLoraLine(
      "Iter 10: Train loss 2.134, Learning Rate 1.000e-05, It/sec 1.250, Tokens/sec 980.5, Trained Tokens 5120, Peak mem 11.42 GB",
      state,
      { nowMs: 2_000, recordedAt: AT },
    );
    expect(train).toEqual({
      kind: "metric",
      tick: {
        iter: 10,
        totalIters: 200,
        trainLoss: 2.134,
        learningRate: 1e-5,
        tokSec: 980.5,
        trainedTokens: 5120,
        itSec: 1.25,
        etaSec: 152,
        peakMemGb: 11.42,
        recordedAt: AT,
      },
    });

    const val = parseMlxLoraLine("Iter 50: Val loss 1.890, Val took 4.10s", state, {
      nowMs: 5_000,
      recordedAt: AT,
    });
    expect(val).toEqual({
      kind: "metric",
      tick: {
        iter: 50,
        totalIters: 200,
        valLoss: 1.89,
        peakMemGb: 11.42,
        recordedAt: AT,
      },
    });
  });

  it("parses test eval summary, sequence truncation warnings, and Metal OOM lines", () => {
    const state = createMlxMetricParserState(50);

    expect(
      parseMlxLoraLine("Test loss 1.423, Test ppl 4.150.", state, {
        nowMs: 1_000,
        recordedAt: AT,
      }),
    ).toEqual({
      kind: "test_summary",
      testLoss: 1.423,
      testPerplexity: 4.15,
    });

    expect(
      parseMlxLoraLine(
        "[WARNING] Some sequences are longer than 2048 tokens. The longest sentence 4192 will be truncated to 2048.",
        state,
        { nowMs: 1_000, recordedAt: AT },
      ),
    ).toEqual({
      kind: "sequence_truncated",
      maxLen: 2048,
      observedLen: 4192,
    });

    const oomLine =
      "RuntimeError: [METAL] Command buffer execution failed: kIOGPUCommandBufferCallbackErrorOutOfMemory";
    expect(isMetalOomLine(oomLine)).toBe(true);
    expect(parseMlxLoraLine(oomLine, state, { nowMs: 1_000, recordedAt: AT })).toEqual({
      kind: "oom",
      line: oomLine,
    });

    expect(stripAnsi("\u001b[31mError\u001b[0m")).toBe("Error");
  });
});

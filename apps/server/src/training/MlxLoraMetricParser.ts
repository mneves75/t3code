import type { TrainingMetricTick } from "@t3tools/contracts";

// Strips CSI and OSC ANSI escape sequences forced by rich.Console(color_system="truecolor").
const ANSI_ESCAPE_PATTERN =
  /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g;

// mlx_lm 0.32.x Rich TrainUI row: "  10    1.842 ▼    1,420     4.2k"
const RICH_TRAIN_ROW_PATTERN =
  /^(\d+)\s+([0-9]+(?:\.[0-9]+)?)\s+[▼▲]\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)([kKmM]?)$/;

// mlx_lm 0.32.x Rich TrainUI val row: "  200    val 1.512    3.42s"
const RICH_VAL_ROW_PATTERN = /^(\d+)\s+val\s+([0-9]+(?:\.[0-9]+)?)\s+([\d.]+)s$/;

// Legacy mlx_lm < 0.30 train row
const LEGACY_TRAIN_ROW_PATTERN =
  /^Iter\s+(\d+):\s+Train loss\s+([0-9.]+),\s+Learning Rate\s+([0-9.eE+-]+),\s+It\/sec\s+([0-9.]+),\s+Tokens\/sec\s+([0-9.]+),\s+Trained Tokens\s+(\d+),\s+Peak mem\s+([0-9.]+)\s+GB$/;

// Legacy mlx_lm < 0.30 val row
const LEGACY_VAL_ROW_PATTERN = /^Iter\s+(\d+):\s+Val loss\s+([0-9.]+),\s+Val took\s+([0-9.]+)s$/;

// Test eval summary (mlx_lm/lora.py:335)
const TEST_EVAL_SUMMARY_PATTERN = /^Test loss\s+([0-9.]+),\s+Test ppl\s+([0-9.]+)\.?$/;

// Sequence truncation warning (mlx_lm/tuner/trainer.py:152-156)
const TRUNCATION_WARNING_PATTERN =
  /^\[WARNING\]\s+Some sequences are longer than (\d+) tokens\.\s+The longest sentence (\d+)/;

// Metal / Python OOM patterns on stderr
const OOM_STDERR_PATTERN =
  /Metal.*Out of memory|kIOGPUCommandBufferCallbackErrorOutOfMemory|MemoryError|MLX.*out of memory|insufficient memory/i;

export type MlxParsedLine =
  | { readonly kind: "metric"; readonly tick: TrainingMetricTick }
  | {
      readonly kind: "test_summary";
      readonly testLoss: number;
      readonly testPerplexity: number;
    }
  | {
      readonly kind: "sequence_truncated";
      readonly maxLen: number;
      readonly observedLen: number;
    }
  | { readonly kind: "oom"; readonly line: string }
  | { readonly kind: "ignored" };

export interface MlxMetricParserState {
  readonly totalIters: number;
  lastIter: number | null;
  lastTimestampMs: number | null;
  emaItSec: number | null;
  peakMemGb: number | null;
}

export function createMlxMetricParserState(totalIters: number): MlxMetricParserState {
  return {
    totalIters: Math.max(1, totalIters),
    lastIter: null,
    lastTimestampMs: null,
    emaItSec: null,
    peakMemGb: null,
  };
}

export function stripAnsi(line: string): string {
  return line.replace(ANSI_ESCAPE_PATTERN, "").trim();
}

export function isMetalOomLine(rawLine: string): boolean {
  return OOM_STDERR_PATTERN.test(stripAnsi(rawLine));
}

function parseTrainedTokens(rawNumber: string, suffix: string): number {
  const base = Number.parseFloat(rawNumber.replace(/,/g, ""));
  if (!Number.isFinite(base)) return 0;
  const lower = suffix.toLowerCase();
  if (lower === "k") return Math.round(base * 1_000);
  if (lower === "m") return Math.round(base * 1_000_000);
  return Math.round(base);
}

function updatePeakMem(state: MlxMetricParserState, sampledPeakMemGb?: number): number | undefined {
  if (sampledPeakMemGb !== undefined && Number.isFinite(sampledPeakMemGb) && sampledPeakMemGb > 0) {
    state.peakMemGb =
      state.peakMemGb === null ? sampledPeakMemGb : Math.max(state.peakMemGb, sampledPeakMemGb);
  }
  return state.peakMemGb === null ? undefined : Number(state.peakMemGb.toFixed(3));
}

function updateItSecAndEta(
  state: MlxMetricParserState,
  iter: number,
  nowMs: number,
  explicitItSec?: number,
): { readonly itSec?: number; readonly etaSec?: number } {
  let currentItSec = explicitItSec;
  if (
    currentItSec === undefined &&
    state.lastIter !== null &&
    state.lastTimestampMs !== null &&
    iter > state.lastIter &&
    nowMs > state.lastTimestampMs
  ) {
    const elapsedSec = (nowMs - state.lastTimestampMs) / 1000;
    if (elapsedSec > 0) {
      currentItSec = (iter - state.lastIter) / elapsedSec;
    }
  }
  state.lastIter = iter;
  state.lastTimestampMs = nowMs;

  if (currentItSec !== undefined && Number.isFinite(currentItSec) && currentItSec > 0) {
    state.emaItSec =
      state.emaItSec === null ? currentItSec : 0.3 * currentItSec + 0.7 * state.emaItSec;
  }

  const itSec = state.emaItSec === null ? undefined : Number(state.emaItSec.toFixed(3));
  const remaining = Math.max(0, state.totalIters - iter);
  const etaSec =
    state.emaItSec !== null && state.emaItSec > 0
      ? Math.round(remaining / state.emaItSec)
      : undefined;

  return {
    ...(itSec === undefined ? {} : { itSec }),
    ...(etaSec === undefined ? {} : { etaSec }),
  };
}

export function parseMlxLoraLine(
  rawLine: string,
  state: MlxMetricParserState,
  options: {
    readonly nowMs: number;
    readonly recordedAt: string;
    readonly sampledPeakMemGb?: number;
  },
): MlxParsedLine {
  const clean = stripAnsi(rawLine);
  if (clean.length === 0) return { kind: "ignored" };

  if (OOM_STDERR_PATTERN.test(clean)) {
    return { kind: "oom", line: clean };
  }

  const truncation = TRUNCATION_WARNING_PATTERN.exec(clean);
  if (truncation !== null) {
    return {
      kind: "sequence_truncated",
      maxLen: Number.parseInt(truncation[1]!, 10),
      observedLen: Number.parseInt(truncation[2]!, 10),
    };
  }

  const testSummary = TEST_EVAL_SUMMARY_PATTERN.exec(clean);
  if (testSummary !== null) {
    return {
      kind: "test_summary",
      testLoss: Number.parseFloat(testSummary[1]!),
      testPerplexity: Number.parseFloat(testSummary[2]!),
    };
  }

  const richTrain = RICH_TRAIN_ROW_PATTERN.exec(clean);
  if (richTrain !== null) {
    const iter = Number.parseInt(richTrain[1]!, 10);
    const trainLoss = Number.parseFloat(richTrain[2]!);
    const tokSec = Number.parseFloat(richTrain[3]!.replace(/,/g, ""));
    const trainedTokens = parseTrainedTokens(richTrain[4]!, richTrain[5] ?? "");
    const peakMemGb = updatePeakMem(state, options.sampledPeakMemGb);
    const timing = updateItSecAndEta(state, iter, options.nowMs);
    return {
      kind: "metric",
      tick: {
        iter,
        totalIters: state.totalIters,
        trainLoss,
        tokSec,
        trainedTokens,
        ...timing,
        ...(peakMemGb === undefined ? {} : { peakMemGb }),
        recordedAt: options.recordedAt,
      },
    };
  }

  const richVal = RICH_VAL_ROW_PATTERN.exec(clean);
  if (richVal !== null) {
    const iter = Number.parseInt(richVal[1]!, 10);
    const valLoss = Number.parseFloat(richVal[2]!);
    const peakMemGb = updatePeakMem(state, options.sampledPeakMemGb);
    return {
      kind: "metric",
      tick: {
        iter,
        totalIters: state.totalIters,
        valLoss,
        ...(peakMemGb === undefined ? {} : { peakMemGb }),
        recordedAt: options.recordedAt,
      },
    };
  }

  const legacyTrain = LEGACY_TRAIN_ROW_PATTERN.exec(clean);
  if (legacyTrain !== null) {
    const iter = Number.parseInt(legacyTrain[1]!, 10);
    const trainLoss = Number.parseFloat(legacyTrain[2]!);
    const learningRate = Number.parseFloat(legacyTrain[3]!);
    const explicitItSec = Number.parseFloat(legacyTrain[4]!);
    const tokSec = Number.parseFloat(legacyTrain[5]!);
    const trainedTokens = Number.parseInt(legacyTrain[6]!, 10);
    const reportedPeakMem = Number.parseFloat(legacyTrain[7]!);
    const peakMemGb = updatePeakMem(
      state,
      options.sampledPeakMemGb === undefined
        ? reportedPeakMem
        : Math.max(reportedPeakMem, options.sampledPeakMemGb),
    );
    const timing = updateItSecAndEta(state, iter, options.nowMs, explicitItSec);
    return {
      kind: "metric",
      tick: {
        iter,
        totalIters: state.totalIters,
        trainLoss,
        learningRate,
        tokSec,
        trainedTokens,
        ...timing,
        ...(peakMemGb === undefined ? {} : { peakMemGb }),
        recordedAt: options.recordedAt,
      },
    };
  }

  const legacyVal = LEGACY_VAL_ROW_PATTERN.exec(clean);
  if (legacyVal !== null) {
    const iter = Number.parseInt(legacyVal[1]!, 10);
    const valLoss = Number.parseFloat(legacyVal[2]!);
    const peakMemGb = updatePeakMem(state, options.sampledPeakMemGb);
    return {
      kind: "metric",
      tick: {
        iter,
        totalIters: state.totalIters,
        valLoss,
        ...(peakMemGb === undefined ? {} : { peakMemGb }),
        recordedAt: options.recordedAt,
      },
    };
  }

  return { kind: "ignored" };
}

import type { TrainingMetricTick } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";

import { formatTrainingLoss } from "./TrainingSettings.logic";

const CHART_WIDTH = 560;
const CHART_HEIGHT = 160;
const PAD_LEFT = 46;
const PAD_RIGHT = 14;
const PAD_TOP = 12;
const PAD_BOTTOM = 24;
const PLOT_WIDTH = CHART_WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_HEIGHT = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;

interface LossPoint {
  readonly iter: number;
  readonly loss: number;
}

function buildPolyline(
  points: ReadonlyArray<LossPoint>,
  minIter: number,
  maxIter: number,
  minLoss: number,
  maxLoss: number,
): string {
  const iterSpan = Math.max(1, maxIter - minIter);
  const lossSpan = Math.max(1e-6, maxLoss - minLoss);
  return points
    .map((point) => {
      const x =
        points.length === 1
          ? PAD_LEFT + PLOT_WIDTH / 2
          : PAD_LEFT + ((point.iter - minIter) / iterSpan) * PLOT_WIDTH;
      const y = PAD_TOP + (1 - (point.loss - minLoss) / lossSpan) * PLOT_HEIGHT;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function projectPoint(
  point: LossPoint,
  singleX: boolean,
  minIter: number,
  maxIter: number,
  minLoss: number,
  maxLoss: number,
): { readonly x: number; readonly y: number } {
  const iterSpan = Math.max(1, maxIter - minIter);
  const lossSpan = Math.max(1e-6, maxLoss - minLoss);
  return {
    x: singleX
      ? PAD_LEFT + PLOT_WIDTH / 2
      : PAD_LEFT + ((point.iter - minIter) / iterSpan) * PLOT_WIDTH,
    y: PAD_TOP + (1 - (point.loss - minLoss) / lossSpan) * PLOT_HEIGHT,
  };
}

export function TrainingLossChart({
  metrics,
}: {
  readonly metrics: ReadonlyArray<TrainingMetricTick>;
}) {
  const gt = useGT();
  const trainPoints: LossPoint[] = [];
  const valPoints: LossPoint[] = [];

  for (const tick of metrics) {
    if (tick.trainLoss !== undefined && Number.isFinite(tick.trainLoss)) {
      trainPoints.push({ iter: tick.iter, loss: tick.trainLoss });
    }
    if (tick.valLoss !== undefined && Number.isFinite(tick.valLoss)) {
      valPoints.push({ iter: tick.iter, loss: tick.valLoss });
    }
  }

  const allPoints = [...trainPoints, ...valPoints];
  if (allPoints.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/20 px-4 text-xs text-muted-foreground">
        <T>Waiting for training loss metrics...</T>
      </div>
    );
  }

  let minIter = allPoints[0]!.iter;
  let maxIter = allPoints[0]!.iter;
  let rawMinLoss = allPoints[0]!.loss;
  let rawMaxLoss = allPoints[0]!.loss;

  for (const point of allPoints) {
    if (point.iter < minIter) minIter = point.iter;
    if (point.iter > maxIter) maxIter = point.iter;
    if (point.loss < rawMinLoss) rawMinLoss = point.loss;
    if (point.loss > rawMaxLoss) rawMaxLoss = point.loss;
  }

  const lossPad =
    rawMaxLoss === rawMinLoss ? Math.max(0.1, rawMaxLoss * 0.1) : (rawMaxLoss - rawMinLoss) * 0.08;
  const minLoss = Math.max(0, rawMinLoss - lossPad);
  const maxLoss = rawMaxLoss + lossPad;
  const midLoss = (minLoss + maxLoss) / 2;
  const singleX = maxIter === minIter;

  const latestTrain = trainPoints[trainPoints.length - 1]?.loss;
  const latestVal = valPoints[valPoints.length - 1]?.loss;

  const yTicks = [
    { value: maxLoss, y: PAD_TOP },
    { value: midLoss, y: PAD_TOP + PLOT_HEIGHT / 2 },
    { value: minLoss, y: PAD_TOP + PLOT_HEIGHT },
  ];

  const midIter = Math.round((minIter + maxIter) / 2);
  const xTicks = singleX
    ? [{ iter: minIter, x: PAD_LEFT + PLOT_WIDTH / 2 }]
    : [
        { iter: minIter, x: PAD_LEFT },
        { iter: midIter, x: PAD_LEFT + PLOT_WIDTH / 2 },
        { iter: maxIter, x: PAD_LEFT + PLOT_WIDTH },
      ];

  return (
    <div className="space-y-1.5 rounded-lg border border-border/60 bg-background/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium text-foreground">
          <T>Loss curve</T>
        </span>
        <div className="flex flex-wrap items-center gap-3 text-muted-foreground tabular-nums">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-full bg-primary" aria-hidden />
            <T>
              Train: <Var>{formatTrainingLoss(latestTrain)}</Var>
            </T>
          </span>
          {valPoints.length > 0 ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block size-2 rounded-full bg-warning" aria-hidden />
              <T>
                Val: <Var>{formatTrainingLoss(latestVal)}</Var>
              </T>
            </span>
          ) : null}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="h-36 w-full overflow-visible"
        role="img"
        aria-label={gt("Training and validation loss chart")}
      >
        {yTicks.map((tick) => (
          <g key={tick.y}>
            <line
              x1={PAD_LEFT}
              x2={PAD_LEFT + PLOT_WIDTH}
              y1={tick.y}
              y2={tick.y}
              className="stroke-border/60"
              strokeDasharray="3 3"
              strokeWidth={1}
            />
            <text
              x={PAD_LEFT - 6}
              y={tick.y + 3}
              textAnchor="end"
              className="fill-muted-foreground text-3xs tabular-nums"
            >
              {formatTrainingLoss(tick.value)}
            </text>
          </g>
        ))}

        {xTicks.map((tick) => (
          <text
            key={tick.x}
            x={tick.x}
            y={CHART_HEIGHT - 6}
            textAnchor={
              tick.x === PAD_LEFT ? "start" : tick.x === PAD_LEFT + PLOT_WIDTH ? "end" : "middle"
            }
            className="fill-muted-foreground text-3xs tabular-nums"
          >
            {tick.iter}
          </text>
        ))}

        {trainPoints.length > 1 ? (
          <polyline
            fill="none"
            className="stroke-primary"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            points={buildPolyline(trainPoints, minIter, maxIter, minLoss, maxLoss)}
          />
        ) : trainPoints.length === 1 ? (
          (() => {
            const projected = projectPoint(
              trainPoints[0]!,
              singleX,
              minIter,
              maxIter,
              minLoss,
              maxLoss,
            );
            return <circle cx={projected.x} cy={projected.y} r={3.5} className="fill-primary" />;
          })()
        ) : null}

        {valPoints.length > 1 ? (
          <polyline
            fill="none"
            className="stroke-warning"
            strokeWidth={1.75}
            strokeDasharray="4 2"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={buildPolyline(valPoints, minIter, maxIter, minLoss, maxLoss)}
          />
        ) : null}

        {valPoints.map((point) => {
          const projected = projectPoint(point, singleX, minIter, maxIter, minLoss, maxLoss);
          return (
            <circle
              key={`val-${point.iter}-${point.loss}`}
              cx={projected.x}
              cy={projected.y}
              r={3}
              className="fill-warning"
            />
          );
        })}
      </svg>
    </div>
  );
}

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type ContextMeterCircleProps =
  | {
      kind: "known";
      percent: number;
      totalTokens: number;
      usedTokens: number;
      remainingTokens: number;
    }
  | {
      kind: "unknown";
    };

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  }
  return String(value);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function meterToneClasses(percent: number): {
  progress: string;
  surface: string;
  value: string;
} {
  if (percent <= 15) {
    return {
      progress: "stroke-red-500/90",
      surface: "bg-red-500/[0.06]",
      value: "text-red-600 dark:text-red-300",
    };
  }
  if (percent <= 35) {
    return {
      progress: "stroke-amber-500/90",
      surface: "bg-amber-500/[0.06]",
      value: "text-amber-600 dark:text-amber-300",
    };
  }
  return {
    progress: "stroke-ring/45",
    surface: "bg-ring/[0.05]",
    value: "text-ring/80",
  };
}

export function ContextMeterCircle(props: ContextMeterCircleProps) {
  if (props.kind === "unknown") {
    return null;
  }
  const remainingPercent = clampPercent(props.percent);
  const remainingTokens = formatTokenCount(props.remainingTokens);
  const usedTokens = formatTokenCount(props.usedTokens);
  const totalTokens = formatTokenCount(props.totalTokens);
  const tone = meterToneClasses(remainingPercent);
  const tooltipText = `${remainingPercent}% context remaining • ${usedTokens} used / ${totalTokens} total`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="absolute top-2 right-2 z-10" aria-label={tooltipText}>
            <div
              className={`relative flex size-10 cursor-pointer items-center justify-center rounded-full border border-border/60 bg-background/92 shadow-sm backdrop-blur-md transition-colors ${tone.surface}`}
            >
              <svg
                viewBox="0 0 40 40"
                className="pointer-events-none absolute inset-0 size-full -rotate-90"
                aria-hidden="true"
              >
                <circle
                  cx="20"
                  cy="20"
                  r="17"
                  fill="none"
                  strokeWidth="2.5"
                  pathLength="100"
                  className="stroke-border/70"
                />
                <circle
                  cx="20"
                  cy="20"
                  r="17"
                  fill="none"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  pathLength="100"
                  strokeDasharray={`${remainingPercent} 100`}
                  className={tone.progress}
                />
              </svg>
              <div className="relative flex flex-col items-center leading-none">
                <span className={`font-semibold text-[10px] ${tone.value}`}>
                  {remainingPercent}%
                </span>
                <span className="mt-0.5 max-w-8 text-center text-[6px] leading-[1.05] font-medium tracking-[0.08em] text-muted-foreground/90">
                  left
                </span>
              </div>
            </div>
          </div>
        }
      />
      <TooltipPopup side="top" className="w-44">
        <div className="space-y-2 px-1 py-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                Context
              </div>
              <div className="text-sm font-semibold text-foreground">Window usage</div>
            </div>
            <div className={`text-right text-lg font-semibold leading-none ${tone.value}`}>
              {remainingPercent}%
            </div>
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <div className="text-muted-foreground">Remaining</div>
            <div className="text-right font-medium text-foreground">{remainingTokens}</div>
            <div className="text-muted-foreground">% remaining</div>
            <div className="text-right font-medium text-foreground">{remainingPercent}%</div>
            <div className="text-muted-foreground">Used</div>
            <div className="text-right font-medium text-foreground">{usedTokens}</div>
            <div className="text-muted-foreground">Total</div>
            <div className="text-right font-medium text-foreground">{totalTokens}</div>
          </div>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

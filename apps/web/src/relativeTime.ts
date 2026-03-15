const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;
let relativeTimeFormatter: Intl.RelativeTimeFormat | null = null;

function formatRelativeUnit(value: number, unit: Intl.RelativeTimeFormatUnit): string {
  if (relativeTimeFormatter === null) {
    relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  }
  return relativeTimeFormatter.format(-value, unit);
}

export function formatRelativeTime(isoDate: string, nowMs = Date.now()): string {
  const targetMs = Date.parse(isoDate);
  if (Number.isNaN(targetMs)) {
    return "";
  }

  const diffMs = Math.max(0, nowMs - targetMs);

  if (diffMs < MINUTE_MS) {
    return "just now";
  }
  if (diffMs < HOUR_MS) {
    return formatRelativeUnit(Math.floor(diffMs / MINUTE_MS), "minute");
  }
  if (diffMs < DAY_MS) {
    return formatRelativeUnit(Math.floor(diffMs / HOUR_MS), "hour");
  }
  if (diffMs < WEEK_MS) {
    return formatRelativeUnit(Math.floor(diffMs / DAY_MS), "day");
  }
  if (diffMs < MONTH_MS) {
    return formatRelativeUnit(Math.floor(diffMs / WEEK_MS), "week");
  }
  if (diffMs < YEAR_MS) {
    return formatRelativeUnit(Math.floor(diffMs / MONTH_MS), "month");
  }
  return formatRelativeUnit(Math.floor(diffMs / YEAR_MS), "year");
}

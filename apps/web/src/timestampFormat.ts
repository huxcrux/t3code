export function getTimestampFormatOptions(
  use24Hour: boolean,
  includeSeconds: boolean,
): Intl.DateTimeFormatOptions {
  return {
    hour: "numeric",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
    hour12: !use24Hour,
  };
}

const timestampFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getTimestampFormatter(use24Hour: boolean, includeSeconds: boolean): Intl.DateTimeFormat {
  const cacheKey = `${use24Hour ? "24" : "12"}:${includeSeconds ? "seconds" : "minutes"}`;
  const cachedFormatter = timestampFormatterCache.get(cacheKey);
  if (cachedFormatter) {
    return cachedFormatter;
  }

  const formatter = new Intl.DateTimeFormat(
    undefined,
    getTimestampFormatOptions(use24Hour, includeSeconds),
  );
  timestampFormatterCache.set(cacheKey, formatter);
  return formatter;
}

export function formatTimestamp(isoDate: string, use24Hour: boolean): string {
  return getTimestampFormatter(use24Hour, true).format(new Date(isoDate));
}

export function formatShortTimestamp(isoDate: string, use24Hour: boolean): string {
  return getTimestampFormatter(use24Hour, false).format(new Date(isoDate));
}

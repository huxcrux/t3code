const DEFAULT_SEEN_NOTIFICATION_LIMIT = 512;

export interface SeenNotificationRegistry {
  has(id: string): boolean;
  mark(id: string): void;
}

export function createSeenNotificationRegistry(
  limit = DEFAULT_SEEN_NOTIFICATION_LIMIT,
): SeenNotificationRegistry {
  const seenIds = new Set<string>();

  return {
    has(id) {
      return seenIds.has(id);
    },
    mark(id) {
      if (seenIds.has(id)) {
        return;
      }

      seenIds.add(id);
      if (seenIds.size <= limit) {
        return;
      }

      const oldestId = seenIds.values().next().value;
      if (typeof oldestId === "string") {
        seenIds.delete(oldestId);
      }
    },
  };
}

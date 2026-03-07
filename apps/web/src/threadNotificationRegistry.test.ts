import { describe, expect, it } from "vitest";

import { createSeenNotificationRegistry } from "./threadNotificationRegistry";

describe("createSeenNotificationRegistry", () => {
  it("records ids after they are marked", () => {
    const registry = createSeenNotificationRegistry();

    expect(registry.has("id-1")).toBe(false);
    registry.mark("id-1");
    expect(registry.has("id-1")).toBe(true);
  });

  it("suppresses duplicate ids without evicting them", () => {
    const registry = createSeenNotificationRegistry(2);

    registry.mark("id-1");
    registry.mark("id-1");
    registry.mark("id-2");

    expect(registry.has("id-1")).toBe(true);
    expect(registry.has("id-2")).toBe(true);
  });

  it("evicts the oldest ids after reaching the registry limit", () => {
    const registry = createSeenNotificationRegistry(2);

    registry.mark("id-1");
    registry.mark("id-2");
    registry.mark("id-3");

    expect(registry.has("id-1")).toBe(false);
    expect(registry.has("id-2")).toBe(true);
    expect(registry.has("id-3")).toBe(true);
  });
});

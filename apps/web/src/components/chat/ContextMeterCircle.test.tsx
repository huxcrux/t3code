import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ContextMeterCircle } from "./ContextMeterCircle";

describe("ContextMeterCircle", () => {
  it("renders nothing for unknown state", () => {
    expect(renderToStaticMarkup(<ContextMeterCircle kind="unknown" />)).toBe("");
  });

  it("renders the measured percent for known threads", () => {
    const markup = renderToStaticMarkup(
      <ContextMeterCircle
        kind="known"
        percent={80}
        totalTokens={400_000}
        usedTokens={80_000}
        remainingTokens={320_000}
      />,
    );

    expect(markup).toContain("80%");
    expect(markup).toContain("80% context remaining");
    expect(markup).toContain('stroke-dasharray="80 100"');
  });
});

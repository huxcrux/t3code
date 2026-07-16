import { describe, expect, it } from "vite-plus/test";

import { shouldShowOpenInPicker } from "./ChatHeader";

describe("shouldShowOpenInPicker", () => {
  it("shows the picker when the active environment has an editor option", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        hasEditorOptions: true,
      }),
    ).toBe(true);
  });

  it("hides the picker when no editor options are available", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        hasEditorOptions: false,
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        hasEditorOptions: true,
      }),
    ).toBe(false);
  });
});

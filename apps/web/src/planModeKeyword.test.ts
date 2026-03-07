import { describe, expect, it } from "vitest";

import {
  INITIAL_PLAN_MODE_KEYWORD_STATE,
  promptMatchesPlanModeKeyword,
  reducePlanModeKeywordState,
} from "./planModeKeyword";

describe("promptMatchesPlanModeKeyword", () => {
  it("matches the keyword case-insensitively", () => {
    expect(promptMatchesPlanModeKeyword("Please PLAN this change", "plan")).toBe(true);
  });

  it("matches multi-word phrases as standalone text", () => {
    expect(promptMatchesPlanModeKeyword("Can you ship plan details next?", "ship plan")).toBe(true);
  });

  it("does not match substrings inside larger words", () => {
    expect(promptMatchesPlanModeKeyword("We are planning the rollout", "plan")).toBe(false);
  });

  it("ignores mention chips when checking for matches", () => {
    expect(promptMatchesPlanModeKeyword("@docs/plan.md", "plan")).toBe(false);
    expect(promptMatchesPlanModeKeyword("please @docs/plan.md soon", "plan")).toBe(false);
  });
});

describe("reducePlanModeKeywordState", () => {
  it("enables and disables auto override as the prompt match changes", () => {
    const upgraded = reducePlanModeKeywordState(INITIAL_PLAN_MODE_KEYWORD_STATE, {
      type: "draft-evaluated",
      baseInteractionMode: "default",
      shouldAutoPlan: true,
      now: 100,
    });

    expect(upgraded).toMatchObject({
      autoOverrideToPlan: true,
      keywordSuppressedForCurrentDraft: false,
      lastAutoModeChangeAt: 100,
    });

    const downgraded = reducePlanModeKeywordState(upgraded, {
      type: "draft-evaluated",
      baseInteractionMode: "default",
      shouldAutoPlan: false,
      now: 200,
    });

    expect(downgraded).toMatchObject({
      autoOverrideToPlan: false,
      keywordSuppressedForCurrentDraft: false,
      lastAutoModeChangeAt: 200,
    });
  });

  it("suppresses further keyword switching after a manual override", () => {
    const upgraded = reducePlanModeKeywordState(INITIAL_PLAN_MODE_KEYWORD_STATE, {
      type: "draft-evaluated",
      baseInteractionMode: "default",
      shouldAutoPlan: true,
      now: 100,
    });

    const suppressed = reducePlanModeKeywordState(upgraded, {
      type: "manual-mode-changed",
      shouldSuppress: true,
    });

    expect(suppressed).toMatchObject({
      autoOverrideToPlan: false,
      keywordSuppressedForCurrentDraft: true,
    });

    const stillSuppressed = reducePlanModeKeywordState(suppressed, {
      type: "draft-evaluated",
      baseInteractionMode: "default",
      shouldAutoPlan: true,
      now: 200,
    });

    expect(stillSuppressed.autoOverrideToPlan).toBe(false);
    expect(stillSuppressed.keywordSuppressedForCurrentDraft).toBe(true);
  });

  it("does not auto override when the base mode is already plan", () => {
    const nextState = reducePlanModeKeywordState(INITIAL_PLAN_MODE_KEYWORD_STATE, {
      type: "draft-evaluated",
      baseInteractionMode: "plan",
      shouldAutoPlan: true,
      now: 100,
    });

    expect(nextState).toBe(INITIAL_PLAN_MODE_KEYWORD_STATE);
  });

  it("resets the transient draft state", () => {
    const upgraded = reducePlanModeKeywordState(INITIAL_PLAN_MODE_KEYWORD_STATE, {
      type: "draft-evaluated",
      baseInteractionMode: "default",
      shouldAutoPlan: true,
      now: 100,
    });

    expect(reducePlanModeKeywordState(upgraded, { type: "draft-reset" })).toMatchObject({
      autoOverrideToPlan: false,
      keywordSuppressedForCurrentDraft: false,
      lastAutoModeChangeAt: 100,
    });
  });
});

import type { ProviderInteractionMode } from "@t3tools/contracts";

import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";

export const DEFAULT_PLAN_MODE_KEYWORD = "plan";
export const MAX_PLAN_MODE_KEYWORD_LENGTH = 64;

export interface PlanModeKeywordState {
  autoOverrideToPlan: boolean;
  keywordSuppressedForCurrentDraft: boolean;
  lastAutoModeChangeAt: number | null;
}

export const INITIAL_PLAN_MODE_KEYWORD_STATE: PlanModeKeywordState = Object.freeze({
  autoOverrideToPlan: false,
  keywordSuppressedForCurrentDraft: false,
  lastAutoModeChangeAt: null,
});

type PlanModeKeywordAction =
  | {
      type: "draft-evaluated";
      baseInteractionMode: ProviderInteractionMode;
      shouldAutoPlan: boolean;
      now: number;
    }
  | {
      type: "manual-mode-changed";
      shouldSuppress: boolean;
    }
  | {
      type: "draft-reset";
    }
  | {
      type: "flash-settled";
    };

function normalizedLowercaseText(input: string): string {
  return input.replace(/\s+/g, " ").trim().toLowerCase();
}

function isWordBoundaryCharacter(char: string | undefined): boolean {
  return char === undefined || !/[a-z0-9_]/i.test(char);
}

export function normalizePlanModeKeyword(keyword: string | null | undefined): string {
  const normalized = (keyword ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PLAN_MODE_KEYWORD_LENGTH);
  return normalized.length > 0 ? normalized : DEFAULT_PLAN_MODE_KEYWORD;
}

export function promptMatchesPlanModeKeyword(prompt: string, keyword: string): boolean {
  const normalizedKeyword = normalizedLowercaseText(normalizePlanModeKeyword(keyword));
  if (normalizedKeyword.length === 0) {
    return false;
  }

  const searchablePrompt = normalizedLowercaseText(
    splitPromptIntoComposerSegments(prompt)
      .filter((segment) => segment.type === "text")
      .map((segment) => segment.text)
      .join(" "),
  );
  if (searchablePrompt.length === 0) {
    return false;
  }

  let matchIndex = searchablePrompt.indexOf(normalizedKeyword);
  while (matchIndex !== -1) {
    const before = searchablePrompt[matchIndex - 1];
    const after = searchablePrompt[matchIndex + normalizedKeyword.length];
    if (isWordBoundaryCharacter(before) && isWordBoundaryCharacter(after)) {
      return true;
    }
    matchIndex = searchablePrompt.indexOf(normalizedKeyword, matchIndex + 1);
  }

  return false;
}

export function reducePlanModeKeywordState(
  state: PlanModeKeywordState,
  action: PlanModeKeywordAction,
): PlanModeKeywordState {
  switch (action.type) {
    case "draft-reset":
      if (state.lastAutoModeChangeAt === null) {
        return INITIAL_PLAN_MODE_KEYWORD_STATE;
      }
      return {
        ...INITIAL_PLAN_MODE_KEYWORD_STATE,
        lastAutoModeChangeAt: state.lastAutoModeChangeAt,
      };
    case "flash-settled":
      if (state.lastAutoModeChangeAt === null) {
        return state;
      }
      return {
        ...state,
        lastAutoModeChangeAt: null,
      };
    case "manual-mode-changed":
      return {
        autoOverrideToPlan: false,
        keywordSuppressedForCurrentDraft:
          action.shouldSuppress || state.keywordSuppressedForCurrentDraft,
        lastAutoModeChangeAt: state.lastAutoModeChangeAt,
      };
    case "draft-evaluated": {
      const canAutoOverride =
        action.baseInteractionMode === "default" && !state.keywordSuppressedForCurrentDraft;
      const nextAutoOverrideToPlan = canAutoOverride && action.shouldAutoPlan;
      if (nextAutoOverrideToPlan === state.autoOverrideToPlan) {
        return state;
      }
      return {
        ...state,
        autoOverrideToPlan: nextAutoOverrideToPlan,
        lastAutoModeChangeAt: action.now,
      };
    }
  }
}

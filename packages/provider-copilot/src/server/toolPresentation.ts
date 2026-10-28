import type { OrchestrationV2TurnItem, OrchestrationV2TurnItemStatus } from "@t3tools/contracts";
import { formatReadToolLabel, formatSearchToolLabel } from "@t3tools/shared/toolActivity";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";

/** Tools whose work T3 renders through dedicated rows (subagents, questions, plans, todos). */
export const COPILOT_TOOLS_WITH_NATIVE_ROWS = new Set([
  "task",
  "ask_user",
  "exit_plan_mode",
  "report_intent",
  "update_todo",
  "task_complete",
]);

export interface CopilotToolState {
  readonly toolName: string;
  readonly toolTitle?: string | undefined;
  readonly arguments?: unknown;
  readonly mcpServerName?: string | undefined;
  readonly mcpToolName?: string | undefined;
  readonly displayCommand?: string | undefined;
  readonly output?: string | undefined;
  readonly detailedOutput?: string | undefined;
  readonly error?: string | undefined;
  readonly exitCode?: number | undefined;
  readonly fileEdits?: ReadonlyArray<{ readonly path: string }> | undefined;
}

type Fields<
  T extends OrchestrationV2TurnItem["type"],
  K extends keyof Extract<OrchestrationV2TurnItem, { type: T }>,
> = Pick<Extract<OrchestrationV2TurnItem, { type: T }>, K>;

export type CopilotToolPresentation = {
  readonly title: string | null;
  readonly toolIcon?: Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>["toolIcon"];
  readonly toolSource?: Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>["toolSource"];
} & (
  | Fields<"command_execution", "type" | "input" | "output" | "exitCode">
  | Fields<"file_change", "type" | "fileName" | "oldStr" | "newStr" | "diffStr">
  | Fields<"file_search", "type" | "pattern">
  | Fields<"web_search", "type" | "patterns" | "results">
  | Fields<"dynamic_tool", "type" | "toolName" | "input" | "output">
);

const SHELL_TOOLS = new Set(["bash", "powershell", "shell"]);
const SEARCH_TOOLS = new Set(["grep", "glob", "rg"]);
const READ_TOOLS = new Set(["view", "read", "show_file"]);
const WEB_TOOLS = new Set(["web_fetch", "web_search", "fetch"]);
const EDIT_TOOLS = new Set(["create", "edit", "write", "str_replace", "apply_patch"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArg(args: unknown, ...keys: ReadonlyArray<string>): string | undefined {
  if (!isRecord(args)) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

const SHELL_CONTROL_LINE = /^<(?:shellId: [^>]+ completed|exited) with exit code \d+>$/;

/** Copilot appends shell bookkeeping lines to command output; they are not program output. */
export function stripCopilotShellControlLines(output: string): string {
  return output
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !SHELL_CONTROL_LINE.test(line.trim()))
    .join("\n")
    .trimEnd();
}

function isUnifiedDiff(text: string | undefined): text is string {
  return (
    text !== undefined &&
    (text.includes("diff --git ") ||
      /(?:^|\n)--- [^\n]+\n\+\+\+ [^\n]+\n@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u.test(text))
  );
}

function patchFileName(patch: string | undefined): string | undefined {
  return patch ? /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(patch)?.[1]?.trim() : undefined;
}

export function copilotToolPresentation(
  tool: CopilotToolState,
  status: OrchestrationV2TurnItemStatus,
): CopilotToolPresentation {
  const name = tool.toolName.trim();
  const normalized = name.toLowerCase();
  const failure = status === "failed" ? tool.error : undefined;
  const output = [failure, tool.output].filter(Boolean).join("\n") || undefined;
  const title = tool.toolTitle ?? null;

  if (tool.mcpServerName || tool.mcpToolName) {
    return {
      title,
      ...mcpToolPresentation({
        serverName: tool.mcpServerName,
        toolName: tool.mcpToolName ?? name,
      }),
      type: "dynamic_tool",
      toolName: tool.mcpToolName ?? name,
      input: tool.arguments ?? {},
      ...(output === undefined ? {} : { output }),
    };
  }
  if (SHELL_TOOLS.has(normalized)) {
    return {
      title: stringArg(tool.arguments, "description") ?? title,
      type: "command_execution",
      input: tool.displayCommand ?? stringArg(tool.arguments, "command", "cmd") ?? "",
      ...(output === undefined ? {} : { output: stripCopilotShellControlLines(output) }),
      ...(tool.exitCode === undefined ? {} : { exitCode: tool.exitCode }),
    };
  }
  if (EDIT_TOOLS.has(normalized)) {
    const patch = stringArg(tool.arguments, "input", "patch");
    const fileName =
      stringArg(tool.arguments, "path", "file_path", "filePath") ??
      tool.fileEdits?.[0]?.path ??
      patchFileName(patch);
    if (fileName) {
      const oldStr = stringArg(tool.arguments, "old_str", "old_string");
      const newStr = stringArg(tool.arguments, "new_str", "new_string", "file_text", "content");
      const diffStr = isUnifiedDiff(tool.detailedOutput) ? tool.detailedOutput : patch;
      return {
        title: failure ? `${name}: ${failure}` : title,
        type: "file_change",
        fileName,
        ...(oldStr === undefined ? {} : { oldStr }),
        ...(newStr === undefined ? {} : { newStr }),
        ...(diffStr === undefined ? {} : { diffStr }),
      };
    }
  }
  if (SEARCH_TOOLS.has(normalized)) {
    const pattern = stringArg(tool.arguments, "pattern", "query");
    return {
      title:
        formatSearchToolLabel({
          input: tool.arguments,
          ...(pattern === undefined ? {} : { pattern }),
        }) ?? title,
      type: "file_search",
      ...(pattern === undefined ? {} : { pattern }),
    };
  }
  if (WEB_TOOLS.has(normalized)) {
    const query = stringArg(tool.arguments, "query", "url");
    const url = stringArg(tool.arguments, "url");
    return {
      title,
      type: "web_search",
      ...(query === undefined ? {} : { patterns: [query] }),
      ...(output === undefined ? {} : { results: [{ ...(url ? { url } : {}), snippet: output }] }),
    };
  }
  return {
    title: READ_TOOLS.has(normalized)
      ? formatReadToolLabel(stringArg(tool.arguments, "path") ?? "")
      : title,
    type: "dynamic_tool",
    toolName: READ_TOOLS.has(normalized) ? "Read" : name,
    input: tool.arguments ?? {},
    ...(output === undefined ? {} : { output }),
  };
}

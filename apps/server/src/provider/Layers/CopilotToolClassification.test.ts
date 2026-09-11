import * as NodeAssert from "node:assert/strict";

import { describe, it } from "@effect/vitest";

import {
  classifyCopilotToolItemType,
  isReadOnlyCopilotToolName,
} from "./CopilotToolClassification.ts";

describe("CopilotToolClassification", () => {
  it("classifies Copilot tool lifecycle items consistently", () => {
    NodeAssert.equal(classifyCopilotToolItemType({ toolName: "bash" }), "command_execution");
    NodeAssert.equal(
      classifyCopilotToolItemType({ toolName: "Task_complete" }),
      "dynamic_tool_call",
    );
    NodeAssert.equal(
      classifyCopilotToolItemType({
        toolName: "update",
        arguments: {
          path: "README.md",
          content: "new content",
        },
      }),
      "file_change",
    );
    NodeAssert.equal(
      classifyCopilotToolItemType({
        toolName: "run_in_terminal",
        arguments: {
          command: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: README.md\nPATCH",
        },
      }),
      "file_change",
    );
    NodeAssert.equal(
      classifyCopilotToolItemType({
        toolName: "execute",
        arguments: {
          filePath: "README.md",
          newString: "updated",
        },
      }),
      "file_change",
    );
    NodeAssert.equal(classifyCopilotToolItemType({ toolName: "Read" }), "dynamic_tool_call");
    NodeAssert.equal(classifyCopilotToolItemType({ toolName: "web_fetch" }), "web_search");
    NodeAssert.equal(classifyCopilotToolItemType({ toolName: "screenshot" }), "image_view");
    NodeAssert.equal(
      classifyCopilotToolItemType({ toolName: "call_tool", mcpServerName: "github" }),
      "mcp_tool_call",
    );
    NodeAssert.equal(classifyCopilotToolItemType({ toolName: "TodoWrite" }), "dynamic_tool_call");
  });

  it("only classifies delegation tools as agent calls", () => {
    for (const toolName of [
      "task",
      "Agent",
      "delegate",
      "runSubagent",
      "run_subagent",
      "spawn_agent",
    ]) {
      NodeAssert.equal(
        classifyCopilotToolItemType({ toolName }),
        "collab_agent_tool_call",
        toolName,
      );
    }
    for (const toolName of [
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet",
      "TaskOutput",
      "TaskStop",
      "task_complete",
      "list_agents",
      "read_agent",
      "agent_status",
      "list_tasks",
      "read_task",
      "skill",
    ]) {
      NodeAssert.equal(classifyCopilotToolItemType({ toolName }), "dynamic_tool_call", toolName);
    }
    NodeAssert.equal(
      classifyCopilotToolItemType({ toolName: "run_task_command" }),
      "command_execution",
    );
    NodeAssert.equal(
      classifyCopilotToolItemType({
        toolName: "task",
        mcpServerName: "project-management",
      }),
      "mcp_tool_call",
    );
  });

  it("detects read-only Copilot tools", () => {
    NodeAssert.equal(isReadOnlyCopilotToolName("Read"), true);
    NodeAssert.equal(isReadOnlyCopilotToolName("read_file"), true);
    NodeAssert.equal(isReadOnlyCopilotToolName("grep"), true);
    NodeAssert.equal(isReadOnlyCopilotToolName("edit_file"), false);
    NodeAssert.equal(isReadOnlyCopilotToolName("bash"), false);
  });
});

import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";

import type { CreateCopilotClient } from "./server/runtime.ts";

export { makeCopilotAdapterV2 } from "./server/adapter.ts";
export { COPILOT_PROVIDER } from "./server/runtime.ts";

/**
 * Runs `scriptPath` with Node in place of the Copilot CLI, keeping the real SDK.
 * `env` receives the CLI command the adapter resolved and the cwd it chose.
 */
export function makeScriptedCopilotClient(input: {
  readonly scriptPath: string;
  readonly env: (cli: {
    readonly command: ReadonlyArray<string>;
    readonly cwd: string | undefined;
  }) => Record<string, string>;
}): CreateCopilotClient {
  return (options) => {
    const connection = options.connection;
    const command =
      connection?.kind === "stdio" && connection.path !== undefined
        ? [connection.path, ...(connection.args ?? [])]
        : [];
    return new CopilotClient({
      ...options,
      connection: RuntimeConnection.forStdio({
        path: process.execPath,
        args: ["--experimental-strip-types", input.scriptPath],
      }),
      env: {
        ...options.env,
        ...input.env({ command, cwd: options.workingDirectory }),
      },
    });
  };
}

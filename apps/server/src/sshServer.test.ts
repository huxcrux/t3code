import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as SshServer from "./sshServer.ts";

describe("SshServerDetector", () => {
  it.effect("reports a loopback SSH listener", () =>
    Effect.gen(function* () {
      const probedHosts: string[] = [];
      const status = yield* SshServer.detectLocalSshServer((host) => {
        probedHosts.push(host);
        return Effect.succeed(host === "::1");
      });
      assert.deepEqual(status, {
        checked: true,
        running: true,
        port: 22,
      });
      assert.deepEqual(probedHosts, ["127.0.0.1", "::1"]);
    }),
  );

  it.effect("reports when no loopback SSH listener exists", () =>
    Effect.gen(function* () {
      const status = yield* SshServer.detectLocalSshServer(() => Effect.succeed(false));
      assert.deepEqual(status, {
        checked: true,
        running: false,
        port: 22,
      });
    }),
  );
});

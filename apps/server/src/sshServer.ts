import * as NodeNet from "node:net";

import { type ServerSshServerStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const DEFAULT_SSH_SERVER_PORT = 22;

export interface SshServerDetectorShape {
  readonly getStatus: Effect.Effect<ServerSshServerStatus>;
}

export class SshServerDetector extends Context.Reference<SshServerDetectorShape>(
  "t3/sshServer/SshServerDetector",
  {
    defaultValue: () => ({
      getStatus: Effect.succeed({
        checked: false,
        running: false,
        port: DEFAULT_SSH_SERVER_PORT,
      }),
    }),
  },
) {}

export type SshBannerProbe = (host: string, port: number) => Effect.Effect<boolean>;

export const probeSshBanner: SshBannerProbe = (host, port) =>
  Effect.callback<boolean>((resume) => {
    const socket = NodeNet.createConnection({ host, port });
    let settled = false;
    let output = "";
    const settle = (running: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(Effect.succeed(running));
    };

    socket.unref();
    socket.setTimeout(500);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      output += chunk;
      if (output.split(/\r?\n/u).some((line) => line.startsWith("SSH-"))) {
        settle(true);
      } else if (output.length >= 512) {
        settle(false);
      }
    });
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
    socket.once("close", () => settle(false));

    return Effect.sync(() => socket.destroy());
  });

export const detectLocalSshServer = Effect.fn("sshServer.detectLocal")(function* (
  probe: SshBannerProbe,
) {
  const running = yield* Effect.zipWith(
    probe("127.0.0.1", DEFAULT_SSH_SERVER_PORT),
    probe("::1", DEFAULT_SSH_SERVER_PORT),
    (ipv4, ipv6) => ipv4 || ipv6,
  );
  return {
    checked: true,
    running,
    port: DEFAULT_SSH_SERVER_PORT,
  } satisfies ServerSshServerStatus;
});

const live = SshServerDetector.of({
  getStatus: detectLocalSshServer(probeSshBanner),
});

export const layer = Layer.succeed(SshServerDetector, live);

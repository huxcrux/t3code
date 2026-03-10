import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getWebBundleBuildReason } from "./webBundle.ts";

const tempDirs: string[] = [];

function createWebDir(): string {
  const webDir = mkdtempSync(join(tmpdir(), "t3code-web-bundle-"));
  tempDirs.push(webDir);
  mkdirSync(join(webDir, "src"), { recursive: true });
  writeFileSync(join(webDir, "src", "main.tsx"), "export {};\n", "utf8");
  return webDir;
}

function setMtime(filePath: string, epochSeconds: number): void {
  utimesSync(filePath, epochSeconds, epochSeconds);
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("getWebBundleBuildReason", () => {
  it("reports a missing web dist bundle", async () => {
    const webDir = createWebDir();

    await expect(getWebBundleBuildReason(webDir)).resolves.toBe(
      "apps/web/dist/index.html is missing",
    );
  });

  it("reports stale bundles when a web source file is newer than dist", async () => {
    const webDir = createWebDir();
    const srcDirPath = join(webDir, "src");
    mkdirSync(join(webDir, "dist"), { recursive: true });
    const distIndexPath = join(webDir, "dist", "index.html");
    const srcFilePath = join(webDir, "src", "main.tsx");
    writeFileSync(distIndexPath, "<!doctype html>\n", "utf8");
    setMtime(distIndexPath, 1_000);
    setMtime(srcFilePath, 2_000);
    setMtime(srcDirPath, 2_000);

    await expect(getWebBundleBuildReason(webDir)).resolves.toBe(
      "apps/web sources are newer than apps/web/dist",
    );
  });

  it("reuses the existing bundle when dist is newer than watched web inputs", async () => {
    const webDir = createWebDir();
    const srcDirPath = join(webDir, "src");
    mkdirSync(join(webDir, "dist"), { recursive: true });
    const distIndexPath = join(webDir, "dist", "index.html");
    const srcFilePath = join(webDir, "src", "main.tsx");
    writeFileSync(distIndexPath, "<!doctype html>\n", "utf8");
    setMtime(srcFilePath, 1_000);
    setMtime(srcDirPath, 1_000);
    setMtime(distIndexPath, 2_000);

    await expect(getWebBundleBuildReason(webDir)).resolves.toBeNull();
  });
});

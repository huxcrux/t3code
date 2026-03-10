import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const WEB_BUILD_INPUT_RELATIVE_PATHS = [
  "index.html",
  "package.json",
  "public",
  "src",
  "tsconfig.json",
  "vite.config.ts",
] as const;

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "ENOENT"
  );
}

async function newestMtimeMsForPath(targetPath: string): Promise<number> {
  let stats;
  try {
    stats = await stat(targetPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return 0;
    }
    throw error;
  }

  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }

  let newest = stats.mtimeMs;
  for (const entry of await readdir(targetPath, { withFileTypes: true })) {
    newest = Math.max(newest, await newestMtimeMsForPath(join(targetPath, entry.name)));
  }

  return newest;
}

export async function getWebBundleBuildReason(webDir: string): Promise<string | null> {
  const distIndexPath = join(webDir, "dist", "index.html");
  let distStats;

  try {
    distStats = await stat(distIndexPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return "apps/web/dist/index.html is missing";
    }
    throw error;
  }

  let newestInputMtimeMs = 0;
  for (const relativePath of WEB_BUILD_INPUT_RELATIVE_PATHS) {
    newestInputMtimeMs = Math.max(
      newestInputMtimeMs,
      await newestMtimeMsForPath(join(webDir, relativePath)),
    );
  }

  if (newestInputMtimeMs > distStats.mtimeMs) {
    return "apps/web sources are newer than apps/web/dist";
  }

  return null;
}

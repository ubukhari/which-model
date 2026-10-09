/** The installed package version, read from package.json: one place, so it cannot drift. */
import { readFileSync } from "node:fs";

let cached: string | undefined;

export function version(): string {
  if (cached !== undefined) return cached;
  try {
    cached = (
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
        version: string;
      }
    ).version;
  } catch {
    cached = "0.0.0";
  }
  return cached;
}

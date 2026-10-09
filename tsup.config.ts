import { defineConfig } from "tsup";

/**
 * One runtime dependency, `seatledger`, for its transcript readers, its loader and its step
 * detector; it has none of its own. `seatledger` stays external (tsup leaves dependencies out of
 * the bundle), so npx installs two packages and the readers are never copied.
 * Nothing in either opens a network connection on the paths which-model calls.
 *
 * `removeNodeProtocol: false` keeps `node:` on built-in imports: `node:sqlite`, which reads Codex's
 * log database, exists only under that name, and `import("sqlite")` would find nothing.
 */
export default defineConfig({
  entry: { cli: "src/cli.ts", index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  removeNodeProtocol: false,
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  clean: true,
  splitting: false,
});

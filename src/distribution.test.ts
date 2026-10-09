/**
 * The files that put which-model where people already are: the package, the README and its
 * picture, the CHANGELOG, the repo-root files the sync copies from `distribution/root` (the Claude
 * Code plugin marketplace), and the synthetic sample on agentcheck's /which-model page. The public
 * repo has the root files at its root and no agentcheck, so those checks run in the monorepo only.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { runDemo, screenshotText, textToSvg, type Demo } from "./demo.js";
import { INSTALL, ON_NPM, REPO, RUN } from "./install.js";

const here = (rel: string): URL => new URL(`../${rel}`, import.meta.url);
const read = (rel: string): string => readFileSync(here(rel), "utf8");
const json = <T>(rel: string): T => JSON.parse(read(rel)) as T;
const pkg = json<{
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  files: string[];
  bin: Record<string, string>;
  homepage: string;
}>("package.json");

let demo: Demo;
beforeAll(async () => {
  demo = await runDemo();
});

describe("package", () => {
  it("depends on seatledger and nothing else", () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["seatledger"]);
  });

  it("ships the CLI and the files the README points at", () => {
    expect(pkg.name).toBe("which-model");
    expect(pkg.bin).toEqual({ "which-model": "./dist/cli.js" });
    expect(pkg.files).toEqual(expect.arrayContaining(["dist", "README.md", "CHANGELOG.md"]));
    expect(pkg.homepage).toBe("https://agentwares-agentcheck.vercel.app/which-model");
  });

  it("CHANGELOG has a section for this version", () => {
    expect(read("CHANGELOG.md")).toMatch(
      new RegExp(`^## ${pkg.version.replace(/\./g, "\\.")} `, "m"),
    );
  });
});

describe("README", () => {
  const readme = read("README.md");

  it("leads with the one-line use and the picture, labelled synthetic", () => {
    expect(readme).toContain("```sh\n" + INSTALL + "\n```");
    expect(readme).toContain("docs/screenshot.svg");
    expect(readme).toMatch(/synthetic history\s+generated for the demo, not anyone's usage/);
  });

  it("says what Codex does not record, and cites the public reports with dates", () => {
    expect(readme).toContain("the model it **requested**");
    for (const issue of [
      "openai/codex#30364",
      "anthropics/claude-code#78888",
      "openai/codex#32806",
    ])
      expect(readme).toContain(issue);
    expect(readme).toContain("8 October 2026");
  });

  it("the picture is the CLI's real output on synthetic history (run `pnpm screenshot` after changing it)", () => {
    const svg = textToSvg(screenshotText(demo));
    if (process.env["WHICH_MODEL_WRITE_INSTALL"]) writeFileSync(here("docs/screenshot.svg"), svg);
    expect(read("docs/screenshot.svg")).toBe(svg);
  });
});

const root = "distribution/root";
const frontmatter = (text: string): Record<string, string> =>
  Object.fromEntries(
    (text.split("---")[1] ?? "")
      .split("\n")
      .map((l) => /^([a-z-]+):\s*(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1]!, m[2]!.replace(/^"|"$/g, "")]),
  );

describe.skipIf(!existsSync(here(root)))("repo-root files (distribution/root)", () => {
  it("the marketplace's plugin resolves, and its version matches this package", () => {
    const marketplace = json<{
      name: string;
      owner: { name: string };
      plugins: { name: string; source: string }[];
    }>(`${root}/.claude-plugin/marketplace.json`);
    // agentguard's marketplace is "agentwares" and seatledger's "seatledger"
    expect(marketplace.name).toBe("which-model");
    expect(marketplace.owner.name).toBe("agentwares");
    expect(marketplace.plugins).toHaveLength(1);
    for (const entry of marketplace.plugins) {
      expect(entry.source.startsWith("./")).toBe(true);
      const plugin = json<{ name: string; version: string }>(
        `${root}/${entry.source.slice(2)}/.claude-plugin/plugin.json`,
      );
      expect(plugin.name).toBe(entry.name);
      expect(plugin.version).toBe(pkg.version);
    }
  });

  it("plugin.json links the page, the docs, the repository, privacy, terms and support", () => {
    const plugin = json<Record<string, string>>(
      `${root}/plugins/which-model/.claude-plugin/plugin.json`,
    );
    expect(plugin.homepage).toBe(pkg.homepage);
    expect(plugin.documentationUrl).toBe("https://github.com/agentwares/which-model#readme");
    expect(plugin.repository).toBe("https://github.com/agentwares/which-model");
    for (const k of ["privacyPolicyUrl", "termsOfServiceUrl", "supportUrl"])
      expect(plugin[k]).toMatch(/^https:\/\/agentwares/);
    expect(plugin.license).toBe("MIT");
  });

  it("the one skill runs the published CLI", () => {
    expect(readdirSync(here(`${root}/plugins/which-model/skills`))).toEqual(["which-model"]);
    const text = read(`${root}/plugins/which-model/skills/which-model/SKILL.md`);
    const front = frontmatter(text);
    expect(front.name).toBe("which-model");
    expect(front.description!.length).toBeGreaterThan(80);
    expect(front.description!.length).toBeLessThanOrEqual(1024);
    expect(text).toContain(`${RUN} $ARGUMENTS`);
  });

  it("no skill or manifest pre-approves a tool: Claude Code asks before every command", () => {
    const walk = (dir: string): string[] =>
      readdirSync(here(dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
      );
    const files = walk(`${root}/plugins`);
    for (const f of files.filter((x) => x.endsWith(".md"))) {
      const text = read(f);
      const front = text.startsWith("---") ? (text.split("---")[1] ?? "") : "";
      expect(front, f).not.toMatch(/^\s*(allowed-tools|allowedTools)\s*:/m);
    }
    for (const f of [
      ...files.filter((x) => x.endsWith(".json")),
      `${root}/.claude-plugin/marketplace.json`,
    ])
      expect(read(f), f).not.toMatch(/allowed-?tools/i);
  });

  it("the listing icon is a 1024 px square PNG drawn from distribution/icon.svg (`pnpm icon`)", () => {
    const plugin = json<{ icon?: string }>(
      `${root}/plugins/which-model/.claude-plugin/plugin.json`,
    );
    expect(plugin.icon).toBe("./.claude-plugin/icon.png");
    const file = `${root}/plugins/which-model/${plugin.icon!.slice(2)}`;
    const png = readFileSync(here(file));
    expect(statSync(here(file)).size).toBeLessThan(2 * 1024 * 1024);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1024);
    const key = "which-model-icon-source-sha256\0";
    const at = png.indexOf(key, 0, "latin1");
    expect(at, "icon.png carries no source hash: run `pnpm icon`").toBeGreaterThan(0);
    const drawnFrom = png.subarray(at + key.length, at + key.length + 64).toString("latin1");
    const svg = createHash("sha256").update(read("distribution/icon.svg")).digest("hex");
    expect(drawnFrom, "distribution/icon.svg changed: run `pnpm icon`").toBe(svg);
  });

  it("the plugin folder has the README the directory lists it by, naming what it runs", () => {
    const readme = read(`${root}/plugins/which-model/README.md`);
    expect(readme.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(40);
    expect(readme).toContain(RUN);
    expect(readme).toContain("pre-approves nothing");
    expect(readme).not.toMatch(/`[^`]*\.png[^`]*`/);
  });
});

/**
 * The terminal sample on agentcheck's /which-model page is this CLI's demo output. To regenerate:
 *
 *   WHICH_MODEL_WRITE_SAMPLE=1 pnpm --filter which-model exec vitest run src/distribution
 *   pnpm exec prettier --write apps/agentcheck/src/app/which-model/_sample.ts
 */
const SAMPLE = here("../agentcheck/src/app/which-model/_sample.ts");
describe.skipIf(!existsSync(SAMPLE))("the sample on agentcheck's /which-model page", () => {
  it("is what the `demo` command prints", async () => {
    const lines = demo.text.split("\n");
    const asOf = new Date(demo.now).toISOString().slice(0, 10);
    if (process.env["WHICH_MODEL_WRITE_SAMPLE"])
      writeFileSync(
        SAMPLE,
        [
          "/**",
          " * The which-model CLI's real output on synthetic history (its `demo` command):",
          " * generated transcripts in the real Claude Code and Codex formats, not anyone's usage.",
          " * Written by apps/which-model-cli/src/distribution.test.ts, which fails when the CLI's",
          " * output changes and this file does not.",
          " */",
          `export const SAMPLE_AS_OF = ${JSON.stringify(asOf)};`,
          `export const SAMPLE_LINES: readonly string[] = ${JSON.stringify(lines)};`,
          "",
        ].join("\n"),
      );
    const sample = (await import(/* @vite-ignore */ SAMPLE.href)) as {
      SAMPLE_AS_OF: string;
      SAMPLE_LINES: readonly string[];
    };
    expect(sample.SAMPLE_AS_OF).toBe(asOf);
    expect([...sample.SAMPLE_LINES]).toEqual(lines);
  });
});

/**
 * One install command (src/install.ts), everywhere it is shown. Any form of it found elsewhere must
 * be INSTALL, or RUN where an agent runs it unattended; code and agentcheck's pages import it rather
 * than spell it. After flipping ON_NPM, rewrite the files that cannot import it:
 *
 *   WHICH_MODEL_WRITE_INSTALL=1 pnpm --filter which-model exec vitest run src/distribution
 *
 * which also redraws docs/screenshot.svg and the mirror agentcheck's pages import.
 */
const COMMAND =
  /npx (?:-{1,2}[\w-]+(?:=[\w-]+)? )*(?:github:agentwares\/)?which-model(?:@latest)?(?![\w./-])/g;
const WRITE = Boolean(process.env["WHICH_MODEL_WRITE_INSTALL"]);
const forms = (text: string): string[] => [...text.matchAll(COMMAND)].map((m) => m[0]);
const walk = (rel: string): string[] =>
  !existsSync(here(rel))
    ? []
    : statSync(here(rel)).isFile()
      ? [rel]
      : readdirSync(here(rel), { withFileTypes: true })
          .filter((e) => !["node_modules", "dist", ".next"].includes(e.name))
          .flatMap((e) => walk(`${rel}/${e.name}`));

/** Re-pad the `# comments` of a shell block that names the command, so its columns line up. */
function realign(text: string): string {
  return text.replace(/```sh\n([\s\S]*?)```/g, (block, body: string) => {
    if (forms(body).length === 0) return block;
    const rows = body.split("\n").map((l) => /^(\S.*?\S)\s{2,}(# .*)$/.exec(l));
    const width = Math.max(0, ...rows.map((m) => (m ? m[1]!.length : 0))) + 2;
    const lines = body.split("\n").map((l, i) => {
      const m = rows[i];
      return m ? m[1]!.padEnd(width) + m[2]! : l;
    });
    return "```sh\n" + lines.join("\n") + "```";
  });
}

describe("the install command", () => {
  it(`is ${INSTALL} while ON_NPM is ${String(ON_NPM)}`, () => {
    expect(INSTALL).toBe(`npx ${ON_NPM ? "" : "--allow-git=root github:agentwares/"}${pkg.name}`);
    expect(RUN).toBe(
      ON_NPM
        ? `npx -y ${pkg.name}@latest`
        : `npx -y --allow-git=root github:agentwares/${pkg.name}`,
    );
    expect(REPO).toBe(`https://github.com/agentwares/${pkg.name}`);
  });

  // README, CHANGELOG and the plugin files in the monorepo; the same files at the root of the
  // public repo, where distribution/root has become the repo root
  const docs = [
    "README.md",
    "CHANGELOG.md",
    ...walk("distribution"),
    ...walk(".claude-plugin"),
    ...walk("plugins"),
  ].filter((f) => /\.(md|json)$/.test(f));

  it.each(docs)("%s names only INSTALL or RUN", (file) => {
    const text = read(file);
    if (WRITE) {
      const next = realign(
        text.replace(COMMAND, (m) => (/ (?:-y|--yes) /.test(m) ? RUN : INSTALL)),
      );
      if (next !== text) writeFileSync(here(file), next);
    }
    for (const form of forms(read(file))) expect([INSTALL, RUN], file).toContain(form);
  });

  it("code, scripts and tests import it rather than spell it", () => {
    const files = [...walk("src"), ...walk("scripts")].filter((f) => f !== "src/install.ts");
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) expect(forms(read(file)), file).toEqual([]);
  });

  it("the README picture shows it", () => {
    expect(screenshotText(demo).split("\n")[0]).toBe(`$ ${INSTALL}`);
  });
});

/** agentcheck's pages import a mirror of src/install.ts, written here; nothing there spells it. */
const AGENTCHECK = "../agentcheck/src";
const MIRROR = `${AGENTCHECK}/app/which-model/_install.ts`;
describe.skipIf(!existsSync(here(AGENTCHECK)))("the install command on agentcheck", () => {
  it("the mirror its pages import is src/install.ts", () => {
    const text = [
      "/**",
      " * How to run which-model, mirrored from apps/which-model-cli/src/install.ts, the one constant.",
      " * Written by apps/which-model-cli/src/distribution.test.ts, which fails when the two differ.",
      " */",
      `export const ON_NPM: boolean = ${String(ON_NPM)};`,
      `export const INSTALL = ${JSON.stringify(INSTALL)};`,
      `export const REPO = ${JSON.stringify(REPO)};`,
      "",
    ].join("\n");
    if (WRITE) writeFileSync(here(MIRROR), text);
    expect(read(MIRROR)).toBe(text);
  });

  it("no other agentcheck file spells the command", () => {
    const files = walk(AGENTCHECK).filter((f) => f !== MIRROR && /\.(tsx?|md|txt|json)$/.test(f));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) expect(forms(read(file)), file).toEqual([]);
  });
});

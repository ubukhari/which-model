/**
 * `which-model demo`: the report on synthetic history, written to a temporary directory and
 * removed afterwards. The README picture and the sample on the /which-model page are this output,
 * and tests keep them identical.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { textToSvg as seatledgerSvg } from "seatledger";
import { analyze, type AnalyzeInput, type Report } from "./analyze.js";
import { collect } from "./collect.js";
import { INSTALL } from "./install.js";
import { renderReport } from "./render.js";
import { writeSyntheticHistory } from "./synthetic.js";

export interface Demo {
  input: AnalyzeInput;
  report: Report;
  text: string;
  now: number;
}

export async function runDemo(): Promise<Demo> {
  const dir = mkdtempSync(path.join(tmpdir(), "which-model-demo-"));
  try {
    const synth = writeSyntheticHistory(dir);
    const input = await collect({
      dirs: { "claude-code": [synth.claudeDir], codex: [synth.codexDir] },
      home: path.join(dir, "home"),
      now: synth.now,
      cache: false,
    });
    const report = analyze(input);
    return { input, report, text: renderReport(report), now: synth.now };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The README picture: the command, then what it printed. */
export function screenshotText(demo: Demo): string {
  return [`$ ${INSTALL}`, demo.text].join("\n").trimEnd();
}

/** Terminal-style SVG of plain text (seatledger's renderer, with this tool's label). */
export function textToSvg(text: string): string {
  return seatledgerSvg(text).replace(
    'aria-label="seatledger output on synthetic history"',
    'aria-label="which-model output on synthetic history"',
  );
}

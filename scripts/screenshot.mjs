#!/usr/bin/env node
/**
 * Regenerate docs/screenshot.svg, the README's picture: the real output of `which-model` on the
 * synthetic history (`which-model demo`), never anyone's own transcripts. Run after building dist/.
 * src/distribution.test.ts fails if the committed file drifts from what this would write.
 */
process.env.TZ = "UTC"; // the synthetic days are UTC days
const { writeFileSync } = await import("node:fs");
const { runDemo, screenshotText, textToSvg } = await import("../dist/index.js");

const svg = textToSvg(screenshotText(await runDemo()));
writeFileSync(new URL("../docs/screenshot.svg", import.meta.url), svg);
console.log(`wrote docs/screenshot.svg (${svg.length} bytes)`);

#!/usr/bin/env node
/**
 * Render the plugin's listing icon: distribution/icon.svg → a 1024 px square PNG at
 * distribution/root/plugins/which-model/.claude-plugin/icon.png, which plugin.json's `icon` names
 * and the sync copies to the public repo with the rest of distribution/root.
 *
 *   pnpm --filter which-model icon
 *
 * Drawn by the Chromium the monorepo already has (the `playwright` that assets/readiness-scorer
 * depends on), so nothing is added to this package. The SVG draws its letters as strokes, not
 * text, so the picture does not depend on the fonts installed where it is rendered. The PNG
 * carries a tEXt chunk with the SHA-256 of the SVG it was drawn from; src/distribution.test.ts
 * fails when the SVG changes and the PNG is not drawn again.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { crc32 } from "node:zlib";

const SIZE = 1024;
const SRC = new URL("../distribution/icon.svg", import.meta.url);
const OUT = new URL(
  "../distribution/root/plugins/which-model/.claude-plugin/icon.png",
  import.meta.url,
);
const SOURCE_KEY = "which-model-icon-source-sha256";

/** The PNG with one tEXt chunk, `<key>\0<value>`, placed straight after IHDR. */
function withText(png, key, value) {
  const ihdrEnd = 8 + 4 + 4 + 13 + 4; // signature, then IHDR: length, type, 13 bytes, CRC
  const data = Buffer.concat([Buffer.from(key, "latin1"), Buffer.from([0]), Buffer.from(value)]);
  const type = Buffer.from("tEXt", "latin1");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([png.subarray(0, ihdrEnd), len, type, data, crc, png.subarray(ihdrEnd)]);
}

const svg = readFileSync(SRC, "utf8");
const hash = createHash("sha256").update(svg).digest("hex");
const require = createRequire(
  new URL("../../../assets/readiness-scorer/package.json", import.meta.url),
);
const { chromium } = require("playwright");

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: SIZE, height: SIZE },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}svg{display:block;width:${SIZE}px;height:${SIZE}px}</style></head><body>${svg}</body></html>`,
  );
  const png = await page.screenshot({
    type: "png",
    clip: { x: 0, y: 0, width: SIZE, height: SIZE },
  });
  const out = withText(png, SOURCE_KEY, hash);
  writeFileSync(OUT, out);
  console.log(
    `wrote ${OUT.pathname} (${SIZE}x${SIZE}, ${out.length} bytes, source ${hash.slice(0, 12)})`,
  );
} finally {
  await browser.close();
}

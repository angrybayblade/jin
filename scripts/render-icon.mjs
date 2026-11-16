// Render apps/desktop/icon.svg into apps/desktop/icon.iconset: bun scripts/render-icon.mjs apps/desktop/icon.svg apps/desktop/icon.iconset
import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
const [, , svgPath, outDir] = process.argv;
const svg = readFileSync(svgPath, "utf8");
const b = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const p = await b.newPage();
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = size * scale;
    await p.setViewport({ width: px, height: px });
    await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${px}" height="${px}" `)}</body></html>`);
    await p.screenshot({ path: `${outDir}/icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`, omitBackground: true });
  }
}
await b.close();

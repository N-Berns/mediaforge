#!/usr/bin/env node
// Render the brand PNGs and the Windows .ico from the SVGs in assets/brand/.
//
//   node tools/brand/build-icons.mjs
//
// The outputs are committed, so a release build does not need to run this. Re-run it after editing
// an SVG. The .ico holds PNG-compressed images, which Windows has read since Vista.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const DIR = "assets/brand";
const PNG_SIZES = [16, 32, 48, 64, 128, 256, 512];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const render = (svg, width) =>
  new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { loadSystemFonts: true },
  })
    .render()
    .asPng();

/** Pack PNG images into one .ico. A size of 256 is written as 0 in the directory entry. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size;
    entry[1] = size === 256 ? 0 : size;
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

const icon = readFileSync(`${DIR}/icon.svg`, "utf8");
mkdirSync(`${DIR}/png`, { recursive: true });
for (const size of PNG_SIZES) writeFileSync(`${DIR}/png/icon-${size}.png`, render(icon, size));

writeFileSync(
  `${DIR}/mediaforge.ico`,
  ico(ICO_SIZES.map((size) => ({ size, png: render(icon, size) }))),
);

const social = readFileSync(`${DIR}/social-preview.svg`, "utf8");
writeFileSync(`${DIR}/social-preview.png`, render(social, 1280));
console.error("Wrote assets/brand/png, mediaforge.ico and social-preview.png");

/**
 * ATLAS mobile brand assets — generated, not hand-drawn.
 *
 * Rasterizes the ATLAS "A" monogram (clean white geometric peak, stroke-based,
 * no gradients — see /design.md) onto Atlas Blue #0052ff or transparency for
 * every icon slot Expo needs. Re-run after any tweak:
 *
 *   node apps/mobile/scripts/generate-assets.mjs
 *
 * sharp is not a dependency of @atlas/mobile (native module, only needed at
 * asset-generation time). It ships in the monorepo's pnpm store as a
 * transitive dependency, so we fall back to loading it from there.
 */
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const OUT_DIR = path.join(HERE, "..", "assets", "images");

const ATLAS_BLUE = "#0052ff";
const WHITE = "#ffffff";

async function loadSharp() {
  try {
    const mod = await import("sharp");
    return mod.default;
  } catch {
    // pnpm keeps transitive deps unhoisted — resolve straight from the store.
    const store = path.join(REPO_ROOT, "node_modules", ".pnpm");
    const entry = readdirSync(store).find((d) => /^sharp@\d/.test(d));
    if (!entry) {
      throw new Error(
        "sharp not found in the pnpm store — run `pnpm install` at the repo root",
      );
    }
    const require = createRequire(import.meta.url);
    return require(path.join(store, entry, "node_modules", "sharp"));
  }
}

/**
 * The monogram: an "A" as a single peak (two legs meeting at an apex) with a
 * crossbar, drawn as strokes with round caps — echoes the pill motif of the
 * ATLAS design language. All geometry is proportional to the glyph width so
 * every size renders the same mark.
 *
 * @param {object} opts
 * @param {number} opts.size        canvas edge in px (square)
 * @param {number} opts.glyphWidth  width of the "A" between outer leg centers
 * @param {string | null} opts.background  fill color, or null for transparent
 * @param {string} [opts.ink]       stroke color (default white)
 */
function monogramSvg({ size, glyphWidth, background, ink = WHITE }) {
  const cx = size / 2;
  const cy = size / 2;
  const w = glyphWidth;
  const h = w * 0.82; // slightly wider than tall — stable, grounded peak
  const stroke = w * 0.14;

  const apexX = cx;
  const apexY = cy - h / 2;
  const footY = cy + h / 2;
  const leftX = cx - w / 2;
  const rightX = cx + w / 2;

  // Crossbar sits 66% down the peak; ends tuck inside the legs so the round
  // caps never poke past the outline.
  const t = 0.66;
  const barY = apexY + h * t;
  const barHalf = (w / 2) * t - stroke * 0.55;

  const f = (n) => Number(n.toFixed(2));
  const bg =
    background === null
      ? ""
      : `<rect width="${size}" height="${size}" fill="${background}"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${bg}
  <g stroke="${ink}" stroke-width="${f(stroke)}" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M ${f(leftX)} ${f(footY)} L ${f(apexX)} ${f(apexY)} L ${f(rightX)} ${f(footY)}"/>
    <line x1="${f(cx - barHalf)}" y1="${f(barY)}" x2="${f(cx + barHalf)}" y2="${f(barY)}"/>
  </g>
</svg>`;
}

function solidSvg({ size, color }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="${color}"/></svg>`;
}

/** @type {Array<{file: string, size: number, svg: string}>} */
const ASSETS = [
  {
    // App icon (iOS + fallback): white A at ~55% width on Atlas Blue.
    file: "icon.png",
    size: 1024,
    svg: monogramSvg({ size: 1024, glyphWidth: 563, background: ATLAS_BLUE }),
  },
  {
    // Android adaptive foreground: transparent, glyph inside the ~66% safe
    // zone (glyph diagonal ~578px < 676px safe circle).
    file: "android-icon-foreground.png",
    size: 1024,
    svg: monogramSvg({ size: 1024, glyphWidth: 440, background: null }),
  },
  {
    file: "android-icon-background.png",
    size: 1024,
    svg: solidSvg({ size: 1024, color: ATLAS_BLUE }),
  },
  {
    // Android 13+ themed icon: same mark, white on transparent.
    file: "android-icon-monochrome.png",
    size: 1024,
    svg: monogramSvg({ size: 1024, glyphWidth: 440, background: null }),
  },
  {
    // Splash mark: background comes from the expo-splash-screen plugin config.
    file: "splash-icon.png",
    size: 512,
    svg: monogramSvg({ size: 512, glyphWidth: 307, background: null }),
  },
  {
    file: "favicon.png",
    size: 48,
    svg: monogramSvg({ size: 48, glyphWidth: 28, background: ATLAS_BLUE }),
  },
  {
    // Android status-bar notification icon (expo-notifications plugin):
    // must be white-on-transparent, 96x96.
    file: "notification-icon.png",
    size: 96,
    svg: monogramSvg({ size: 96, glyphWidth: 58, background: null }),
  },
];

const sharp = await loadSharp();
let failed = false;

for (const asset of ASSETS) {
  const outPath = path.join(OUT_DIR, asset.file);
  const buffer = await sharp(Buffer.from(asset.svg)).png().toBuffer();
  await sharp(buffer).toFile(outPath);

  const meta = await sharp(outPath).metadata();
  const ok =
    meta.width === asset.size &&
    meta.height === asset.size &&
    meta.format === "png";
  if (!ok) failed = true;
  console.log(
    `${ok ? "ok " : "FAIL"} ${asset.file.padEnd(32)} ${meta.width}x${meta.height} ${meta.format} ${buffer.length} bytes`,
  );
}

if (failed) {
  console.error("asset generation failed — see FAIL lines above");
  process.exit(1);
}
console.log(`\nAll assets written to ${path.resolve(OUT_DIR)}`);

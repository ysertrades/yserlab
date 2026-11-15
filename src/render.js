import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { createCanvas, loadImage, GlobalFonts, Path2D } from "@napi-rs/canvas";

const FONTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "fonts");
const files = ["Inter-Medium.ttf", "Inter-SemiBold.ttf", "Inter-ExtraBold.ttf", "JetBrainsMono-Regular.ttf", "InstrumentSerif-Italic.ttf"].map(f => path.join(FONTS, f));

let ready = false;
export function fonts() {
  if (ready) return;
  ready = true;
  globalThis.Path2D ??= Path2D; // the shared card code draws the brand mark with it
  // ...and measures text with a throwaway canvas.
  globalThis.document ??= { createElement: () => createCanvas(8, 8), fonts: { load: async () => [], ready: Promise.resolve() } };
  GlobalFonts.registerFromPath(path.join(FONTS, "Inter-Medium.ttf"), "Inter");
  GlobalFonts.registerFromPath(path.join(FONTS, "Inter-SemiBold.ttf"), "Inter");
  GlobalFonts.registerFromPath(path.join(FONTS, "Inter-ExtraBold.ttf"), "Inter");
  // The app's mono face is Geist Mono; JetBrains Mono stands in for it here.
  GlobalFonts.registerFromPath(path.join(FONTS, "JetBrainsMono-Regular.ttf"), "Geist Mono");
  GlobalFonts.registerFromPath(path.join(FONTS, "InstrumentSerif-Italic.ttf"), "Instrument Serif");
}

/** An SVG as a PNG. `width` is the output width in pixels (the picture keeps its proportions). */
export function svgToPng(svg, width = 1600) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { fontFiles: files, loadSystemFonts: false, defaultFontFamily: "Inter", monospaceFamily: "JetBrains Mono", sansSerifFamily: "Inter", serifFamily: "Instrument Serif" },
    background: "rgba(0,0,0,0)",
  });
  return resvg.render().asPng();
}

/** The media trade card: your picture under the ruler and the result, drawn by the same code as the app. */
export async function tradeCardPng(entry, imageBuffer, look = {}) {
  fonts();
  const { drawMediaCard, MW, MH, DIMS } = await import("../vendor/mediaCard.mjs");
  const canvas = createCanvas(MW, MH);
  const context = canvas.getContext("2d");
  const image = imageBuffer ? await loadImage(imageBuffer) : null;
  const dim = DIMS[look.dim] ?? DIMS.medium;
  drawMediaCard(context, { entry, dim, pnl: look.pnl !== false, ruler: look.ruler !== false, brand: !!look.brand }, image ? { el: image, w: image.width, h: image.height } : null, 0);
  return canvas.toBuffer("image/png");
}

export { loadImage };

// Bundles the slides editor's renderer (charts/src/slides) into vendor/slides.mjs, so the bot can draw pages exactly as the editor does.
//   node scripts/slides/build.mjs        (needs the charts repo next to this one, with its node_modules)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const charts = process.env.CHARTS_DIR ?? path.resolve(root, "../charts");
const require = createRequire(path.join(charts, "package.json"));
const esbuild = require("esbuild");

await esbuild.build({
  entryPoints: [path.join(here, "entry.tsx")],
  outfile: path.join(root, "vendor/slides.mjs"),
  bundle: true, format: "esm", platform: "node", target: "node20", minify: true, legalComments: "none",
  alias: { "@": path.join(charts, "src") },
  nodePaths: [path.join(charts, "node_modules")],
  jsx: "automatic",
  // Icon packs load on demand in the editor; the bot uses lucide only.
  external: ["@iconify-json/tabler/icons.json", "@iconify-json/ph/icons.json"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});

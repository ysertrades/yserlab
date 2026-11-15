// Tries the diagram maker without Discord.
//   node scripts/diagram.js "show me a bullish fair value gap" [out.png]     (asks the AI, needs GROQ_API_KEY or GEMINI_API_KEY)
//   node scripts/diagram.js --spec spec.json [out.png]                       (draws a spec you wrote)
import "dotenv/config";
import fs from "node:fs";
import { designDiagram, drawDiagram } from "../src/diagram.js";

const args = process.argv.slice(2);
if (args[0] === "--spec") {
  const png = await drawDiagram(JSON.parse(fs.readFileSync(args[1], "utf8")));
  fs.writeFileSync(args[2] ?? "diagram.png", png);
  console.log("wrote", args[2] ?? "diagram.png");
} else {
  const { png, spec, lessons } = await designDiagram(args[0] ?? "a bullish fair value gap");
  fs.writeFileSync(args[1] ?? "diagram.png", png);
  console.log(JSON.stringify(spec, null, 1)); console.log("lessons:", lessons.map(l => l.title).join(" | "));
  console.log("wrote", args[1] ?? "diagram.png");
}
process.exit(0);

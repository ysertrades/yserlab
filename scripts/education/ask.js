// Try the AI on a question without Discord: the same context and the same provider call the bot makes.
//   node scripts/education/ask.js "what is an fvg and when is it invalid" [--gemini] [--show]
// Your own model isn't loaded here (it lives in your account's storage); pass --model <file.json> to try one.
import "dotenv/config";
import fs from "node:fs";
import { context, viaGemini, viaGroq } from "../../src/ai.js";

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const modelAt = args.indexOf("--model");
const question = args.filter((a, i) => !a.startsWith("--") && i !== modelAt + 1 || (modelAt === -1 && !a.startsWith("--"))).join(" ");
const doc = modelAt >= 0 ? JSON.parse(fs.readFileSync(args[modelAt + 1], "utf8")) : null;
const { env } = await import("../../src/env.js");
const big = flag("--gemini");
const { system, lessons } = context({ doc, rows: [], text: question, history: [], big });
if (flag("--show")) console.log(system + "\n-----");
console.log(`[${big ? "gemini" : "groq"}] prompt ${system.length} chars (~${Math.round(system.length / 3.5)} tokens); lessons: ${lessons.map(l => l.title).join(" | ")}`);
const out = big ? await viaGemini(system, [], question) : await viaGroq(system, [], question);
console.log("\n" + (out.text ?? JSON.stringify(out)));
void env;

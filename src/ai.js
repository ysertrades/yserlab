import { env } from "./env.js";
import { entries, model } from "./store.js";
import { isWin, isLoss } from "./cards.js";

/**
 * The AI: Gemini, answering about your trading with your own model (the PDFs you uploaded in the app) and your journal numbers as
 * context. It can't count: the numbers come from the summary below, which the bot works out itself. It can ask for a picture from a
 * trade; the bot then shows the timeframe and trade dropdowns.
 */
const histories = new Map(); // channel -> [{ role, text, at }]
const KEEP = 8, FORGET = 30 * 60_000;

const TOOLS = [{ functionDeclarations: [{
  name: "show_trade_chart",
  description: "Use when the user wants a picture (a chart or screenshot) from a trade they logged. The bot then asks which trade.",
  parameters: { type: "OBJECT", properties: { timeframe: { type: "STRING", description: "The timeframe or story step they named, such as H4, M15 or Cover. Leave empty if they didn't say." } } },
}] }];

function summary(rows) {
  const done = rows.filter(e => e.pnl != null || e.r_multiple != null);
  const pnl = done.reduce((s, e) => s + (e.pnl ?? 0), 0), r = done.reduce((s, e) => s + (e.r_multiple ?? 0), 0);
  const wins = done.filter(isWin).length, losses = done.filter(isLoss).length;
  const month = new Date().toISOString().slice(0, 7);
  const m = done.filter(e => e.trade_date.startsWith(month));
  const byInstrument = {};
  for (const e of done) { const k = e.instrument ?? "?"; (byInstrument[k] ??= { n: 0, pnl: 0 }); byInstrument[k].n++; byInstrument[k].pnl += e.pnl ?? 0; }
  const lines = done.slice(0, 25).map(e => `${e.trade_date} ${e.instrument ?? "?"} ${e.direction ?? ""} ${e.session ?? ""} pnl=${e.pnl ?? "?"} r=${e.r_multiple ?? "?"} "${(e.title ?? "").slice(0, 50)}"`);
  return [
    `All time: ${done.length} trades, ${wins} wins, ${losses} losses, win rate ${wins + losses ? Math.round(100 * wins / (wins + losses)) : 0}%, pnl ${Math.round(pnl)}, total R ${r.toFixed(2)}.`,
    `This month (${month}): ${m.length} trades, pnl ${Math.round(m.reduce((s, e) => s + (e.pnl ?? 0), 0))}.`,
    `By instrument: ${JSON.stringify(byInstrument)}`,
    `Most recent trades:\n${lines.join("\n")}`,
  ].join("\n");
}

const SYSTEM = `You are YSER Lab, the personal assistant of one trader, living in their Discord server. Be direct, warm and brief: a few sentences, plain words, no filler. Use Discord markdown sparingly.
You know their own trading model (below) and journal numbers. Answer about the model in its own terms. Never invent numbers: use only the figures given; if you don't have something, say so. Never give financial advice or tell them to take a trade; you help them review, learn and stay consistent.
If they ask you to send or show a picture, chart or screenshot from a trade, call show_trade_chart.`;

const GROQ_MODELS = () => [...new Set([env.groqModel, "openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"].filter(Boolean))];
const GEMINI_MODELS = () => [...new Set([env.geminiModel, "gemini-flash-lite-latest", "gemini-2.5-flash-lite"].filter(Boolean))];
const GROQ_TOOLS = TOOLS[0].functionDeclarations.map(f => ({ type: "function", function: { name: f.name, description: f.description, parameters: { type: "object", properties: { timeframe: { type: "string", description: f.parameters.properties.timeframe.description } } } } }));

/** Groq (the chat): an OpenAI-style call with the same tool. Returns { text } or { chart, timeframe }, or throws. */
async function viaGroq(system, history, text) {
  const messages = [{ role: "system", content: system }, ...history.map(h => ({ role: h.role === "model" ? "assistant" : "user", content: h.text })), { role: "user", content: text }];
  let last = "no model answered";
  for (const model of GROQ_MODELS()) {
    try {
      const body = { model, messages, tools: GROQ_TOOLS, temperature: 0.5, max_completion_tokens: 1200 };
      if (model.startsWith("openai/gpt-oss")) body.reasoning_effort = "low";
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.groqKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      if (!response.ok) { last = `AI error ${response.status}`; continue; }
      const message = (await response.json()).choices?.[0]?.message;
      const call = message?.tool_calls?.find(c => c.function?.name === "show_trade_chart");
      if (call) { let args = {}; try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* no arguments */ } return { chart: true, timeframe: args.timeframe || "" }; }
      const answer = String(message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (answer) return { text: answer };
      last = "empty answer";
    } catch (e) { last = e.message; }
  }
  throw new Error(last);
}

/** Gemini: the fallback when Groq isn't set or fails. */
async function viaGemini(system, history, text) {
  const contents = [...history.map(h => ({ role: h.role, parts: [{ text: h.text }] })), { role: "user", parts: [{ text }] }];
  const body = JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, tools: TOOLS, generationConfig: { temperature: 0.5, maxOutputTokens: 1200 } });
  let last = "no model answered";
  for (const name of GEMINI_MODELS()) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${name}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": env.geminiKey }, body, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) { last = `AI error ${response.status}`; continue; }
      const parts = (await response.json()).candidates?.[0]?.content?.parts ?? [];
      const call = parts.find(p => p.functionCall)?.functionCall;
      if (call?.name === "show_trade_chart") return { chart: true, timeframe: call.args?.timeframe || "" };
      const answer = parts.map(p => p.text ?? "").join("").trim();
      if (answer) return { text: answer };
    } catch (e) { last = e.message; }
  }
  throw new Error(last);
}

export async function ask({ owner, channelId, text }) {
  if (!env.groqKey && !env.geminiKey) return { text: "My AI isn't connected yet: add `GROQ_API_KEY` in the host's variables." };
  const [rows, doc] = await Promise.all([entries(owner).catch(() => []), model(owner)]);
  const history = (histories.get(channelId) ?? []).filter(h => Date.now() - h.at < FORGET).slice(-KEEP);
  const system = `${SYSTEM}\n\nTHEIR MODEL (read from the PDFs they uploaded in the app):\n${doc ? JSON.stringify(doc).slice(0, 24000) : "(no model uploaded yet)"}\n\nTHEIR JOURNAL:\n${summary(rows)}\n\nNow: ${new Date().toString().slice(0, 33)}`;
  let out;
  try { out = env.groqKey ? await viaGroq(system, history, text) : await viaGemini(system, history, text); }
  catch (e) { if (!env.groqKey || !env.geminiKey) throw e; out = await viaGemini(system, history, text); }
  const keep = histories.get(channelId) ?? [];
  keep.push({ role: "user", text, at: Date.now() });
  keep.push({ role: "model", text: out.chart ? "(showed a trade chart picker)" : out.text || "…", at: Date.now() });
  histories.set(channelId, keep.slice(-KEEP * 2));
  return out;
}
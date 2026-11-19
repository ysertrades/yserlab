import { env } from "../env.js";

/**
 * Model routing for the text jobs of the intelligence layer (writing and revising drafts, summaries, general questions, structured
 * extraction). Providers: Groq, Gemini and NVIDIA NIM, whichever have a key. Each task has its own preferred order; a provider that fails is
 * skipped for a minute and the next one answers; the conversation lives in the structured memory, not in any provider, so switching loses nothing.
 * Simple operations (listing members, counting, pinning) never reach a model at all: they are deterministic tools.
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const openai = (url, key, models) => async ({ system, messages, temperature, max, json, timeoutMs = 40_000 }) => {
  let last = "no model answered";
  for (const model of models()) {
    try {
      const body = { model, messages: [{ role: "system", content: system }, ...messages], temperature, max_tokens: max };
      if (json) body.response_format = { type: "json_object" };
      if (model.startsWith("openai/gpt-oss")) body.reasoning_effort = "low";
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key()}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) { last = `status ${r.status}`; continue; }
      const text = String((await r.json()).choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (text) return { text, model };
      last = "empty answer";
    } catch (e) { last = e.message; }
  }
  throw new Error(last);
};

const PROVIDERS = {
  groq: { enabled: () => !!env.groqKey, call: openai("https://api.groq.com/openai/v1/chat/completions", () => env.groqKey, () => [...new Set([env.groqModel, "openai/gpt-oss-120b", "openai/gpt-oss-20b"].filter(Boolean))]) },
  nvidia: { enabled: () => !!env.nvidiaKey, call: openai("https://integrate.api.nvidia.com/v1/chat/completions", () => env.nvidiaKey, () => [env.nvidiaModel]) },
  gemini: {
    enabled: () => !!env.geminiKey,
    async call({ system, messages, temperature, max, json, timeoutMs = 45_000 }) {
      let last = "no model answered";
      for (const model of [...new Set([env.geminiModel, "gemini-flash-latest"].filter(Boolean))]) {
        try {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": env.geminiKey }, signal: AbortSignal.timeout(timeoutMs),
            body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })), generationConfig: { temperature, maxOutputTokens: max, ...(json ? { responseMimeType: "application/json" } : {}) } }) });
          if (!r.ok) { last = `status ${r.status}`; continue; }
          const text = ((await r.json()).candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? "").join("").trim();
          if (text) return { text, model };
          last = "empty answer";
        } catch (e) { last = e.message; }
      }
      throw new Error(last);
    },
  },
};

/** The preferred provider order per job: quick structured jobs lean on the fast one, writing and reasoning on the strongest. */
export const ORDER = {
  classify: ["groq", "gemini", "nvidia"], extract: ["groq", "gemini", "nvidia"],
  write: ["gemini", "groq", "nvidia"], reason: ["gemini", "groq", "nvidia"], summarize: ["gemini", "groq", "nvidia"], general: ["groq", "gemini", "nvidia"],
};
let providers = PROVIDERS;
const cooldown = new Map(), COOL = 60_000;
export const setProviders = p => { providers = p ?? PROVIDERS; cooldown.clear(); }; // tests inject stand-ins
export const providerStatus = () => Object.keys(providers).map(n => ({ name: n, on: providers[n].enabled(), cooling: (cooldown.get(n) ?? 0) > Date.now() }));

/**
 * One text completion for a job. Tries the job's providers in order (skipping ones that just failed, unless nothing else is left), retries a
 * provider once on a transient failure, and returns { text, provider, model, tried }. Throws only when every provider failed.
 */
export async function complete({ task = "general", system, messages, temperature = 0.4, max = 900, json = false, retries = 1, deadlineMs = 25_000 }) {
  const t0 = Date.now();
  const order = (ORDER[task] ?? ORDER.general).filter(n => providers[n]?.enabled());
  if (!order.length) throw Object.assign(new Error("no AI provider is configured"), { code: "no_provider" });
  const live = order.filter(n => (cooldown.get(n) ?? 0) <= Date.now()), queue = live.length ? live : order, tried = [];
  for (const name of queue) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const left = deadlineMs - (Date.now() - t0);
      if (left < 1500) { tried.push({ provider: name, error: "out of time" }); break; } // one deadline for the whole call, not per provider
      try {
        const out = await providers[name].call({ system, messages, temperature, max, json, timeoutMs: left });
        cooldown.delete(name);
        return { ...out, provider: name, tried };
      } catch (e) {
        tried.push({ provider: name, error: String(e?.message ?? e).slice(0, 80) });
        if (attempt < retries && queue.length === 1) await sleep(300); // with another provider to try, move on at once
      }
    }
    cooldown.set(name, Date.now() + COOL);
  }
  throw Object.assign(new Error(`every AI provider failed (${tried.map(t => `${t.provider}: ${t.error}`).join("; ")})`), { code: "all_failed", tried });
}

/** Parses a model's JSON answer, tolerating code fences and stray words; null when it is not JSON. */
export function parseJson(text) {
  const t = String(text ?? "").replace(/^```(?:json)?|```$/gm, "").trim();
  try { return JSON.parse(t); } catch { /* try the first object */ }
  const m = /\{[\s\S]*\}/.exec(t);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { PermissionFlagsBits as P } from "discord.js";
import { modules } from "./index.js";
import { panel } from "../admin/ui.js";
import { env } from "../env.js";

/**
 * The page behind a giveaway's "one quick human check" (yserbot's entry verification). A member who presses Enter gets a one-time signed link
 * to /verify; the page reads a few signals from their browser and this server compares them with the accounts already verified in that server
 * (vendor/yserbot/utils/entryVerify.js decides; nothing raw is stored). The routes below are yserbot's own (web/server.js) on a plain HTTP server.
 *
 * It only runs when the host gives the bot a web address: set PUBLIC_BASE_URL (the public https address of this deployment) and the port the host
 * assigns (PORT or SERVER_PORT). Without them the check stays off and a giveaway is entered with one press, so nobody is sent a dead link.
 */
const require = createRequire(import.meta.url);
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../vendor/yserbot/web/public");
const COOKIE = "qb_verify", COOKIE_TTL = 30 * 60 * 1000, LIMIT = { windowMs: 60_000, max: 20 }, MAX_BODY = 32 * 1024;
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".woff2": "font/woff2", ".ttf": "font/ttf", ".png": "image/png", ".jpg": "image/jpeg" };
const ORIGINS = (process.env.VERIFY_PAGE_ORIGIN || "https://yser.app,https://www.yser.app").split(",").map(s => s.trim()).filter(Boolean);
const hits = new Map(), used = new Map();

const limited = key => { const now = Date.now(), r = hits.get(key); if (!r || r.resetAt < now) { hits.set(key, { count: 1, resetAt: now + LIMIT.windowMs }); if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k); return false; } r.count++; return r.count > LIMIT.max; };
const ipOf = req => { const hops = Math.max(0, Number(process.env.TRUST_PROXY_HOPS ?? 1) || 0), direct = req.socket.remoteAddress || "unknown"; if (!hops) return direct; const chain = String(req.headers["x-forwarded-for"] || "").split(",").map(s => s.trim()).filter(Boolean); return chain.length ? chain[Math.max(0, chain.length - hops)] || direct : direct; };
const send = (res, status, body, headers = {}) => { res.writeHead(status, { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...headers }); res.end(body); };
const json = (res, status, data) => send(res, status, JSON.stringify(data), { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
const cookieOf = req => Object.fromEntries(String(req.headers.cookie ?? "").split(";").map(c => c.trim().split("=")).filter(c => c[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
const readBody = req => new Promise((resolve, reject) => { let size = 0; const chunks = []; req.on("data", c => { size += c.length; if (size > MAX_BODY) { reject(new Error("body_too_large")); req.resume(); } else chunks.push(c); }); req.on("end", () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("bad_json")); } }); });
const readLocation = v => { if (!v || typeof v !== "object") return null; if (v.error === "denied" || v.error === "unavailable") return { error: v.error }; const lat = Number(v.lat), lon = Number(v.lon), acc = Number(v.acc); if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null; return { lat, lon, acc: Number.isFinite(acc) && acc > 0 ? acc : Infinity }; };

function serveStatic(res, rel) {
  const file = path.resolve(PUBLIC, rel.replace(/^\/+/, ""));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, "Forbidden", { "content-type": "text/plain" });
  fs.readFile(file, (err, buf) => err ? send(res, 404, "Not found", { "content-type": "text/plain" }) : send(res, 200, buf, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" }));
}

/** A possible alt is reported privately to the giveaway's host and the owner (yserbot sent it to the mod log; this bot has none). */
async function reportAlt(client, guild, t, result, saved) {
  const ids = [...new Set([saved?.hostId, ...env.owners].filter(Boolean))];
  const post = panel({ title: "Possible alt account on a giveaway entry", accent: "amber", pings: [], lines: [`<@${t.u}> was held${result.matchedWith ? `, matching <@${result.matchedWith}>` : ""}.`, result.reason ? `Why: ${result.reason}` : "", saved?.prize ? `Giveaway: **${saved.prize}**` : "", "-# They are not removed: a shared house or office is real. Approve or remove them from the giveaway's list."] });
  for (const id of ids) { const u = await client.users.fetch(id).catch(() => null); await u?.send(post).catch(() => {}); }
}

export function startVerifyServer(client) {
  const base = process.env.PUBLIC_BASE_URL?.trim(), port = Number(process.env.PORT || process.env.SERVER_PORT || 0);
  if (!base || !port) { console.log("giveaways: entry verification is off (set PUBLIC_BASE_URL and the host's PORT to turn it on)"); return null; }
  const m = modules(); if (!m) return null;
  const ev = m.entryVerify, brand = m.brand, ipIntel = require("../../vendor/yserbot/utils/ipIntel");
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x"), p = url.pathname;
      // The check page lives on the app's own domain (yser.app/giveaway-entry) and calls this API from there.
      const origin = req.headers.origin;
      if (p.startsWith("/api/") && origin && ORIGINS.includes(origin)) { res.setHeader("access-control-allow-origin", origin); res.setHeader("vary", "Origin"); res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS"); res.setHeader("access-control-allow-headers", "content-type"); res.setHeader("access-control-max-age", "600"); }
      if (req.method === "OPTIONS" && p.startsWith("/api/")) return send(res, ORIGINS.includes(origin) ? 204 : 403, "");
      if (p === "/verify" || p === "/verify/") {
        const t = url.searchParams.get("t");
        if (t) return send(res, 302, "", { location: "/verify", "set-cookie": `${COOKIE}=${encodeURIComponent(t)}; Max-Age=${COOKIE_TTL / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax` });
        return serveStatic(res, "verify.html");
      }
      if (/^\/(verify\.(css|js)|fonts\/[\w.-]+)$/.test(p)) return serveStatic(res, p);
      if (p === "/api/verify/info" || p === "/api/verify") {
        const ip = ipOf(req);
        if (limited(`verify:${ip}`)) return json(res, 429, { error: "rate_limited" });
        let body = {};
        if (req.method === "POST") { try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); } }
        const raw = (req.method === "POST" ? body.t : url.searchParams.get("t")) || cookieOf(req)[COOKIE];
        if (!raw) return json(res, 400, { error: "missing_link" });
        const t = ev.readToken(raw); if (!t) return json(res, 400, { error: "bad_link" });
        const guild = client.guilds.cache.get(t.g); if (!guild) return json(res, 404, { error: "unknown_server" });
        const b = brand.getBrand(t.g), saved = t.m ? m.giveaway.getActiveGiveaway?.(t.m) : null;
        const member = guild.members.cache.get(t.u);
        const logos = [b.logoUrl || null, client.user?.displayAvatarURL?.({ size: 128, extension: "png" }) || null].filter(Boolean);
        const info = { brand: b.name, logo: logos[0] ?? null, logos, accent: b.accent || null, location: ev.locationMode(t.g), server: guild.name, serverIcon: guild.iconURL?.({ size: 128, extension: "png" }) || null, user: member?.displayName || member?.user?.username || null, prize: saved?.prize || null, returnUrl: t.c && t.m ? `https://discord.com/channels/${t.g}/${t.c}/${t.m}` : `https://discord.com/channels/${t.g}`, dropId: saved?.dropId ? brand.dropRef(saved.dropId, t.g) : null, status: ev.statusOf(t.g, t.u, t.m || null), expired: !!t.expired };
        if (req.method !== "POST") return json(res, 200, info);
        if (t.expired) return json(res, 410, { error: "expired", ...info });
        if (used.has(t.n)) return json(res, 409, { error: "used", ...info });
        const location = readLocation(body.location);
        const intel = await ipIntel.lookup(ev.networkOf(ip) ? String(ip).replace(/^::ffff:/, "") : null);
        const early = ev.precheck(t.g, { intel, location });
        if (early) return json(res, 200, { ...info, status: early.status });
        used.set(t.n, t.e); for (const [n, exp] of used) if (exp < Date.now()) used.delete(n);
        const result = ev.record(t.g, t.u, { ip, device: body.device, fingerprint: body.fingerprint, userAgent: req.headers["user-agent"], messageId: t.m || null, location, intel });
        if (result.status === "flagged" && result.reason) reportAlt(client, guild, t, result, saved).catch(() => {});
        return json(res, 200, { ...info, status: result.status, reason: result.reason });
      }
      send(res, 404, "Not found", { "content-type": "text/plain" });
    } catch (e) { console.warn("verify server:", e?.message ?? e); send(res, 500, "Something went wrong", { "content-type": "text/plain" }); }
  });
  server.listen(port, () => console.log(`giveaways: entry verification page on port ${port} (${base}/verify)`));
  return server;
}

import { db, settings, log } from "./store.js";
import { deliver, picturePost } from "./post.js";
import { svgToPng, fonts } from "./render.js";
import { postToday, postTomorrow, postWeek } from "./calendar/news.js";
import { postCard } from "./cards.js";
import { events, pick } from "./calendar/feed.js";
import { alertCard } from "./calendar/visuals.js";
import { mentions } from "./access.js";
import { giveawayJob } from "./giveaway/sync.js";

/**
 * Things the app asks for: the "Post to Discord" button on a card (job kind "card", carrying the picture as SVG) and the "Send now"
 * buttons in the control panel (job kind "run", naming a feature). Each job is claimed once and answered with its result.
 */
const RUNNERS = {
  "news.today": (c, cfg) => postToday(c, cfg, { force: true }),
  "news.open": (c, cfg) => postTomorrow(c, cfg, { force: true }),
  "news.weekly": (c, cfg) => postWeek(c, cfg, { force: true }),
  "cards.daily": c => postCard(c, "daily", { force: true }),
  "cards.weekly": c => postCard(c, "weekly", { force: true }),
  "cards.monthly": c => postCard(c, "monthly", { force: true }),
  "news.alert": async (c, cfg) => {
    const list = pick(await events(), cfg.news).filter(e => e.at.toMillis() > Date.now() && !e.allDay);
    if (!list.length) { await log("news.alert", { note: "no upcoming release to preview" }, false); return 0; }
    const first = list[0].at.toMillis(), group = list.filter(e => e.at.toMillis() === first);
    fonts();
    const png = svgToPng(alertCard(group, { minutes: 15 }).svg, 1400);
    return deliver(c, cfg.news.alerts.channels, () => picturePost({ text: `${mentions(cfg, cfg.news.alerts.tag)} **Test:** ${group[0].title} (preview of a heads-up)`, png, name: "news-soon.png", accent: "amber" }), "news.alert");
  },
};

export async function checkJobs(client) {
  if (!db) return;
  const { data, error } = await db.from("bot_jobs").select("*").eq("status", "pending").order("created_at", { ascending: true }).limit(5);
  if (error || !data?.length) return;
  for (const job of data) {
    const { data: claimed } = await db.from("bot_jobs").update({ status: "running" }).eq("id", job.id).eq("status", "pending").select("id");
    if (!claimed?.length) continue;
    let result = { ok: true }, status = "done";
    try {
      const { config } = await settings(true);
      if (job.kind === "card") {
        const p = job.payload ?? {};
        if (!p.svg) throw new Error("no card");
        fonts();
        const png = svgToPng(p.svg, Math.min(2000, Math.max(1000, p.w ?? 1600)));
        const channels = p.channels?.length ? p.channels : config.cards.manual.channels;
        const sent = await deliver(client, channels, () => picturePost({ text: p.title ? `**${String(p.title).slice(0, 200)}**` : undefined, png, name: "card.png" }), "cards.manual");
        result = { sent };
        if (!sent && !config.dryRun) throw new Error(channels?.length ? "couldn't send (paused or no access)" : "pick a channel for card posts in YSER Lab");
      } else if (job.kind === "giveaway") {
        result = (await giveawayJob(client, job.payload ?? {})) ?? { ok: true };
      } else if (job.kind === "run" && RUNNERS[job.payload?.feature]) {
        result = { sent: await RUNNERS[job.payload.feature](client, config) };
      } else throw new Error("unknown job");
    } catch (e) {
      status = "failed"; result = { error: e.message };
      await log("job", { error: e.message, kind: job.kind }, false);
    }
    await db.from("bot_jobs").update({ status, result, done_at: new Date().toISOString() }).eq("id", job.id);
  }
}

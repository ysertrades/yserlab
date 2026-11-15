import { ActionRowBuilder, ContainerBuilder, MessageFlags, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextDisplayBuilder } from "discord.js";
import { entries, settings, chartRow, chartBytes, log } from "./store.js";
import { isAdmin } from "./access.js";
import { picturePost, colour } from "./post.js";
import { tradeCardPng, fonts } from "./render.js";

/**
 * Picking a trade with dropdowns. Two flows share it:
 *  - card: you tag the bot on a message with a picture; pick the month and the trade, and the trade card is made from that
 *    picture and that trade's data;
 *  - chart: you ask for a picture from a trade; pick the timeframe (the story step), then the month and the trade.
 */
const sessions = new Map(); // id -> { mode, user, url, tf, month, rows, until }
const TTL = 20 * 60_000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = ym => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const sweep = () => { for (const [k, s] of sessions) if (s.until < Date.now()) sessions.delete(k); };
const newId = () => Math.random().toString(36).slice(2, 10);

const stepsOf = e => (Array.isArray(e.blocks) ? e.blocks : []).filter(b => b.type === "step" && b.chart);
const tfOf = b => String(b.tf || "").trim() || "Chart";
const hasTf = (e, tf) => tf === "Cover" ? !!e.cover_chart : stepsOf(e).some(b => tfOf(b) === tf);

export const timeframes = rows => {
  const found = new Map();
  for (const e of rows) for (const b of stepsOf(e)) found.set(tfOf(b), (found.get(tfOf(b)) ?? 0) + 1);
  const list = [...found.entries()].sort((a, b) => b[1] - a[1]).map(([tf, n]) => ({ tf, n }));
  const covers = rows.filter(e => e.cover_chart).length;
  if (covers) list.push({ tf: "Cover", n: covers });
  return list;
};

const label = e => {
  const side = e.direction ? ` ${e.direction}` : "", pnl = e.pnl != null ? ` · ${e.pnl > 0 ? "+" : e.pnl < 0 ? "−" : ""}$${Math.abs(Math.round(e.pnl))}` : e.r_multiple != null ? ` · ${e.r_multiple > 0 ? "+" : ""}${Number(e.r_multiple).toFixed(2)}R` : "";
  return `${e.trade_date.slice(5)} · ${e.instrument ?? "Trade"}${side}${pnl}`.slice(0, 100);
};

function pickerMessage(sid) {
  const s = sessions.get(sid);
  const pool = s.mode === "chart" ? s.rows.filter(e => hasTf(e, s.tf)) : s.rows;
  const months = [...new Set(pool.map(e => e.trade_date.slice(0, 7)))].sort().reverse().slice(0, 25);
  const month = months.includes(s.month) ? s.month : months[0];
  s.month = month;
  const inMonth = pool.filter(e => e.trade_date.startsWith(month ?? "~")).slice(0, 25);
  const box = new ContainerBuilder().setAccentColor(colour("accent"));
  const title = s.mode === "chart" ? `**Which trade's ${s.tf} chart?**` : "**Which trade is this picture for?**";
  box.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${title}\n-# Pick a month, then the trade.`));
  if (!months.length) {
    box.addTextDisplayComponents(new TextDisplayBuilder().setContent("No trades to pick from yet."));
    return { components: [box], flags: MessageFlags.IsComponentsV2 };
  }
  box.addActionRowComponents(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`lab:m:${sid}`).setPlaceholder("Month").addOptions(months.map(m => new StringSelectMenuOptionBuilder().setLabel(monthName(m)).setDescription(`${pool.filter(e => e.trade_date.startsWith(m)).length} trades`).setValue(m).setDefault(m === month)))));
  box.addActionRowComponents(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`lab:t:${sid}`).setPlaceholder(`Trade in ${monthName(month)}`).addOptions(inMonth.map(e => new StringSelectMenuOptionBuilder().setLabel(label(e)).setDescription((e.title || "").slice(0, 100) || e.session || "—").setValue(e.id)))));
  return { components: [box], flags: MessageFlags.IsComponentsV2 };
}

/** You tagged the bot with a picture. */
export async function startCard(message, owner) {
  const image = [...message.attachments.values()].find(a => a.contentType?.startsWith("image/"));
  if (!image) return false;
  const rows = await entries(owner);
  const sid = newId();
  sessions.set(sid, { mode: "card", user: message.author.id, url: image.url, month: rows[0]?.trade_date.slice(0, 7), rows, until: Date.now() + TTL });
  sweep();
  await message.reply({ ...pickerMessage(sid), allowedMentions: { repliedUser: false } });
  return true;
}

/** The AI worked out you want a picture from a trade: first which timeframe. */
export async function startChart(message, owner, tfHint) {
  const rows = await entries(owner);
  const tfs = timeframes(rows);
  if (!tfs.length) { await message.reply({ content: "None of your trades has a chart attached yet.", allowedMentions: { repliedUser: false } }); return; }
  const sid = newId();
  const match = tfHint && tfs.find(t => t.tf.toLowerCase() === String(tfHint).toLowerCase());
  sessions.set(sid, { mode: "chart", user: message.author.id, tf: match?.tf, month: undefined, rows, until: Date.now() + TTL });
  sweep();
  if (match) { await message.reply({ ...pickerMessage(sid), allowedMentions: { repliedUser: false } }); return; }
  const box = new ContainerBuilder().setAccentColor(colour("accent"));
  box.addTextDisplayComponents(new TextDisplayBuilder().setContent("**Which timeframe's chart do you want?**\n-# From the steps of your trade stories."));
  box.addActionRowComponents(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`lab:f:${sid}`).setPlaceholder("Timeframe").addOptions(tfs.slice(0, 25).map(t => new StringSelectMenuOptionBuilder().setLabel(t.tf).setDescription(`${t.n} trade${t.n === 1 ? "" : "s"}`).setValue(t.tf)))));
  await message.reply({ components: [box], flags: MessageFlags.IsComponentsV2, allowedMentions: { repliedUser: false } });
}

/** Handles the three dropdowns. Returns true when the interaction was ours. */
export async function handle(interaction) {
  if (!interaction.isStringSelectMenu() || !interaction.customId.startsWith("lab:")) return false;
  const [, kind, sid] = interaction.customId.split(":");
  const s = sessions.get(sid);
  const { config, owner } = await settings();
  if (!isAdmin(config, interaction.user.id)) { await interaction.reply({ content: "These are for the admins.", ephemeral: true }); return true; }
  if (!s || s.until < Date.now()) { await interaction.reply({ content: "That picker timed out. Ask again.", ephemeral: true }); return true; }
  if (s.user !== interaction.user.id && !isAdmin(config, interaction.user.id)) { await interaction.reply({ content: "That one isn't yours.", ephemeral: true }); return true; }
  const value = interaction.values[0];
  if (kind === "f") { s.tf = value; await interaction.update(pickerMessage(sid)); return true; }
  if (kind === "m") { s.month = value; await interaction.update(pickerMessage(sid)); return true; }
  if (kind !== "t") return true;
  const entry = s.rows.find(e => e.id === value);
  if (!entry) { await interaction.reply({ content: "I couldn't find that trade.", ephemeral: true }); return true; }
  await interaction.deferUpdate();
  try {
    fonts();
    if (s.mode === "card") {
      const bytes = Buffer.from(await (await fetch(s.url)).arrayBuffer());
      const png = await tradeCardPng(entry, bytes, config.cards.tradeCard);
      const post = picturePost({ png, name: "trade-card.png", footer: label(entry), accent: (entry.pnl ?? entry.r_multiple ?? 0) >= 0 ? "up" : "down" });
      await interaction.editReply({ ...post, attachments: [] });
      sessions.delete(sid);
      await log("tradecard", { note: label(entry) });
    } else {
      const step = s.tf === "Cover" ? null : stepsOf(entry).find(b => tfOf(b) === s.tf);
      const chartId = step?.chart ?? entry.cover_chart;
      const row = chartId ? await chartRow(chartId) : null;
      if (!row) { await interaction.followUp({ content: "That trade has no chart for this timeframe.", ephemeral: true }); return true; }
      const png = await chartBytes(row.storage_path);
      const post = picturePost({ png, name: "chart.png", text: `**${label(entry)}** · ${s.tf}${step?.text ? `\n${String(step.text).slice(0, 600)}` : ""}` });
      await interaction.editReply({ ...post, attachments: [] });
      sessions.delete(sid);
      await log("chart", { note: `${label(entry)} ${s.tf}` });
    }
  } catch (e) {
    await log("picker", { error: e.message }, false);
    await interaction.followUp({ content: `That didn't work: ${e.message}`, ephemeral: true }).catch(() => {});
  }
  return true;
}

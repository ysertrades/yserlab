import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, SeparatorBuilder, SeparatorSpacingSize, TextDisplayBuilder } from "discord.js";
import { colour } from "../post.js";

/**
 * Every rich message the administrator sends is a Components V2 container (text displays, a separator, action rows), built here so they all look
 * the same and every payload is checked against Discord's limits before it is sent. One-line confirmations stay plain text, like the rest of the bot's replies.
 */
export const LIMITS = { text: 4000, components: 40, rowButtons: 5 };

export function panel({ title, lines = [], accent = "accent", footer, rows = [], pings = [] }) {
  const box = new ContainerBuilder().setAccentColor(colour(accent));
  const head = title ? `### ${title}` : "";
  const foot = footer ? `-# ${footer}` : "";
  const room = LIMITS.text - head.length - foot.length - 40;
  let body = lines.filter(x => x != null && x !== "").join("\n");
  if (body.length > room) body = body.slice(0, Math.max(0, room - 30)).replace(/\n[^\n]*$/, "") + "\n-# …shortened to fit Discord's limit";
  if (head) box.addTextDisplayComponents(new TextDisplayBuilder().setContent(head));
  if (body) { box.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)); box.addTextDisplayComponents(new TextDisplayBuilder().setContent(body)); }
  if (foot) box.addTextDisplayComponents(new TextDisplayBuilder().setContent(foot));
  for (const row of rows) box.addActionRowComponents(row);
  return check({ components: [box], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [], users: pings } });
}

/** Throws before sending when a V2 payload could not be accepted, so a mistake here never reaches Discord as an opaque error. */
export function check(payload) {
  if (!(payload.flags & MessageFlags.IsComponentsV2)) throw new Error("a rich message must carry the Components V2 flag");
  if (payload.content) throw new Error("a Components V2 message cannot have plain content");
  if (payload.embeds?.length) throw new Error("a Components V2 message cannot have embeds");
  let text = 0, count = 0;
  const walk = c => { const j = c.toJSON ? c.toJSON() : c; count++; if (typeof j.content === "string") text += j.content.length; if (j.type === 1 && (j.components?.length ?? 0) > LIMITS.rowButtons) throw new Error("an action row holds at most five buttons"); (j.components ?? []).forEach(walk); if (j.accessory) walk(j.accessory); };
  (payload.components ?? []).forEach(walk);
  if (text > LIMITS.text) throw new Error(`the text of a Components V2 message is limited to ${LIMITS.text} characters (this has ${text})`);
  if (count > LIMITS.components) throw new Error(`a Components V2 message holds at most ${LIMITS.components} components (this has ${count})`);
  return payload;
}

/**
 * Asks the requester to confirm with two buttons that expire. Only they can press them. True only on Confirm; the buttons never act on a
 * stale message because the collector ends with the time, and a press by anyone else is ignored.
 */
export async function confirmButtons(message, { title, lines = [], ttl = 30_000, danger = true }) {
  if (!message.id || !message.channel?.send) return true; // scheduled: nobody to ask, the request was confirmed when it was set up
  const id = Math.random().toString(36).slice(2, 8);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ok:${id}`).setLabel("Confirm").setStyle(danger ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`no:${id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary));
  const sent = await message.channel.send(panel({ title, lines: [...lines, "", `-# Only ${message.author?.username ?? "the requester"} can answer. This expires in ${Math.round(ttl / 1000)} seconds.`], accent: "amber", rows: [row] }));
  let ok = false, text = "Cancelled. Nothing was changed.", accent = "flat";
  try {
    const press = await sent.awaitMessageComponent({ filter: i => i.customId.endsWith(id) && i.user.id === message.author.id, time: ttl });
    ok = press.customId.startsWith("ok:");
    if (ok) { text = "Confirmed. Running it now."; accent = "up"; }
    await press.update(panel({ title: ok ? "Confirmed" : "Cancelled", lines: [text], accent })).catch(() => {});
  } catch { await sent.edit(panel({ title: "Expired", lines: ["No answer in time. Nothing was changed."], accent: "flat" })).catch(() => {}); }
  setTimeout(() => sent.delete().catch(() => {}), 5000);
  return ok;
}
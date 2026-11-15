import { AttachmentBuilder, ContainerBuilder, FileBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags, SeparatorBuilder, TextDisplayBuilder } from "discord.js";
import { settings, log } from "./store.js";

const ACCENT = { up: 0x3ccf7a, down: 0xf06b6b, accent: 0x8d9bff, amber: 0xf5b544, flat: 0x8e8e94 };
export const colour = name => ACCENT[name] ?? ACCENT.accent;

/** A Components V2 post: an optional line of text (the tags go here), the picture, and an optional small footer. */
export function picturePost({ text, png, name = "card.png", footer, accent = "accent" }) {
  const file = new AttachmentBuilder(png, { name });
  const box = new ContainerBuilder().setAccentColor(colour(accent));
  if (text) box.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  box.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${name}`)));
  if (footer) box.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footer}`));
  return { components: [box], files: [file], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: ["users"] } };
}

/** A V2 post with only text. */
export function textPost({ text, accent = "accent" }) {
  const box = new ContainerBuilder().setAccentColor(colour(accent)).addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  return { components: [box], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: ["users"] } };
}

/**
 * Sends one post to several channels. Nothing goes out while the bot is paused (or in dry-run, which only logs). Returns
 * how many channels it reached; a channel it can't reach is logged, never thrown.
 */
export async function deliver(client, channelIds, build, kind) {
  const { config } = await settings();
  const targets = [...new Set((channelIds ?? []).filter(Boolean))];
  if (!targets.length) { await log(kind, { note: "no channel chosen" }, false); return 0; }
  if (config.paused) { await log(kind, { note: "paused: not sent" }, false); return 0; }
  if (config.dryRun) { await log(kind, { note: "dry run: would send", channels: targets }); return 0; }
  let sent = 0;
  for (const id of targets) {
    try {
      const channel = await client.channels.fetch(id);
      if (!channel?.isSendable?.()) throw new Error("not a channel the bot can send to");
      await channel.send(build());
      sent++;
    } catch (e) {
      await log(kind, { error: `#${id}: ${e.message}`, channel: id }, false);
    }
  }
  if (sent) await log(kind, { note: `sent to ${sent} channel${sent === 1 ? "" : "s"}`, channels: targets });
  return sent;
}
export { FileBuilder, SeparatorBuilder };

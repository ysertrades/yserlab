import { createRequire } from "node:module";
import { Collection } from "discord.js";
import { log } from "../store.js";

/**
 * The giveaway and verification systems from the yserbot repository, run inside this bot. The yserbot code is copied verbatim into
 * vendor/yserbot (CommonJS, its own default branding untouched); this file is the thin bridge: it loads those modules, registers their two slash
 * commands (/giveaway and /verify), routes their buttons, menus and modals, restores running giveaways after a restart, and exposes the same
 * functions the yserbot control panel used (web/giveaways.js) to the AI, the app panel and the tests.
 * Changes made to the copied files are marked YSERLAB (extra entries for named members, editing and cancelling a running giveaway).
 */
const require = createRequire(import.meta.url);
const base = "../../vendor/yserbot";
let mods = null, failure = null;

export function modules() {
  if (mods || failure) return mods;
  try {
    mods = {
      giveaway: require(`${base}/commands/utility/giveaway.js`),
      verify: require(`${base}/commands/utility/verify.js`),
      panel: require(`${base}/web/giveaways.js`),
      handlers: require(`${base}/events/giveawayVerify.js`),
      duration: require(`${base}/utils/duration.js`),
      entryVerify: require(`${base}/utils/entryVerify.js`),
      brand: require(`${base}/utils/brand.js`),
    };
  } catch (e) { failure = e; console.warn("giveaways: could not load the yserbot modules:", e?.message ?? e); }
  return mods;
}
export const loadError = () => failure;

/** Sets up the client: its command table, the slash commands, and the running giveaways. */
export async function startGiveaways(client) {
  const m = modules(); if (!m) return false;
  client.commands = new Collection([["giveaway", m.giveaway], ["verify", m.verify]]);
  try {
    await client.application.commands.set([m.giveaway.data.toJSON(), m.verify.data.toJSON()]);
  } catch (e) { console.warn("giveaways: registering /giveaway and /verify failed:", e?.message ?? e); }
  try { await m.giveaway.restoreGiveaways(client); } catch (e) { console.warn("giveaways: restore failed:", e?.message ?? e); }
  await log("giveaway", { note: "giveaways and verification ready" });
  return true;
}

const OURS = /^(gaw_|giveaway_|verify_)/;
/** Routes a Discord interaction to the yserbot handlers. Returns true when it was one of theirs. */
export async function routeInteraction(interaction, client) {
  const m = modules(); if (!m || !client.commands) return false;
  const h = m.handlers;
  if (interaction.isAutocomplete?.() && ["giveaway", "verify"].includes(interaction.commandName)) { await h.handleAutocomplete(interaction, client); return true; }
  if (interaction.isChatInputCommand?.() && ["giveaway", "verify"].includes(interaction.commandName)) { await h.handleCommand(interaction, client); return true; }
  const id = interaction.customId ?? "";
  if (interaction.isButton?.() && OURS.test(id)) { await h.handleButton(interaction, client); return true; }
  if (interaction.isModalSubmit?.() && OURS.test(id) || interaction.isModalSubmit?.() && id === "verify_rules_modal") { await h.handleModal(interaction, client); return true; }
  if ((interaction.isStringSelectMenu?.() || interaction.isRoleSelectMenu?.() || interaction.isChannelSelectMenu?.()) && OURS.test(id)) { await h.handleSelect(interaction, client); return true; }
  return false;
}

/** The legacy text command `g.reroll <id>`. */
export async function routeText(message) {
  const m = modules(); if (!m || !message.guild || !/^g\.reroll\b/i.test(message.content ?? "")) return false;
  await m.giveaway.reroll(message, message.content.split(/\s+/)[1]).catch(e => console.warn("g.reroll:", e?.message ?? e));
  return true;
}

/** The panel functions of yserbot (list, create, endNow, reroll, remove, participants, ...), with the guild and a session for the host. */
export function api() { const m = modules(); return m ? { ...m.panel, update: m.giveaway.updateGiveaway, cancel: m.giveaway.cancelGiveaway, active: id => m.giveaway.getActiveGiveaway(id), parseDuration: m.duration.parseDuration } : null; }

export const MAX_DURATION_MS = 30 * 24 * 3600 * 1000;

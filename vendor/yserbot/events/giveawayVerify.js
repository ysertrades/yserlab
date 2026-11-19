'use strict';

/**
 * YSERLAB: the giveaway and verification parts of yserbot's events/interactionCreate.js, copied verbatim (line ranges noted) and gathered
 * into one handler so the rest of that file (tickets, polls, embeds, automod, economy...) is not needed. Run by src/giveaway/index.js.
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { createEmbed } = require('../utils/embedBuilder');
const { readJson, writeJson } = require('../utils/jsonStorage');

const embedUtil = { error: (title, desc) => createEmbed('error', { title, description: desc }) };
const EPHEMERAL_FLAG = 64;
const reportAndLog = (err, ctx) => console.error('[interaction]', ctx?.area, ctx?.customId || '', err);
function isUnknownInteractionError(err) {
  return err?.code === 10062 || err?.rawError?.code === 10062;
}

// ── yserbot interactionCreate.js lines 97-130 ──
// ── Giveaway participants helpers ─────────────────────────────────────────────
const PAGE_SIZE = 10;

function buildParticipantsEmbed(giveawayMsgId, page) {
  const entrants   = global.giveawayEntrants?.get(giveawayMsgId) || new Set();
  const members    = Array.from(entrants).map(id => `<@${id}>`);
  const total      = members.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage   = Math.max(1, Math.min(page, totalPages));
  const slice      = members.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle('🏅 Giveaway Participants')
    .setDescription(total === 0 ? 'No participants yet.' : slice.map((m, i) => `**${(safePage - 1) * PAGE_SIZE + i + 1}.** ${m}`).join('\n'))
    .setFooter({ text: `Page ${safePage}/${totalPages} • ${total} participant${total !== 1 ? 's' : ''}` });

  return { embed, totalPages, currentPage: safePage };
}

function buildParticipantsRow(giveawayMsgId, currentPage, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gaw_p:${giveawayMsgId}:${currentPage}`)
      .setLabel('◄ Prev').setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage <= 1),
    new ButtonBuilder()
      .setCustomId(`gaw_n:${giveawayMsgId}:${currentPage}`)
      .setLabel('Next ►').setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages),
  );
}



async function handleButton(interaction, client) {
  const id = interaction.customId;
  try {
    // ── yserbot lines 288-552: giveaway buttons ──
        // Giveaway — setup panel buttons
        if (id.startsWith('gaw_setup:')) {
          return await client.commands.get('giveaway')?.handleSetupButton(interaction);
        }

        // Giveaway — list view: delete-ended-giveaway confirm/back
        if (id.startsWith('gaw_list_delyes:') || id === 'gaw_list_delno') {
          return await client.commands.get('giveaway')?.handleListButton(interaction);
        }

        // Giveaway — enter
        if (id === 'giveaway_ended') {
          return interaction.reply({ content: 'This giveaway has already ended.', flags: EPHEMERAL_FLAG }).catch(() => {});
        }
        
        if (id.startsWith('gaw_alt_')) {
          const parts = id.split(':');
          const action = parts[0];
          const msgId = parts[1];
          const userId = parts[2];
          if (!interaction.memberPermissions?.has?.('ManageMessages') && !interaction.memberPermissions?.has?.('ModerateMembers')) {
            return interaction.reply({ content: 'Moderator permission required.', flags: EPHEMERAL_FLAG }).catch(() => {});
          }
          if (!global.giveawayEntrants) global.giveawayEntrants = new Map();
          let entrants = global.giveawayEntrants.get(msgId);
          if (!entrants) {
            const saved = client.commands.get('giveaway')?.getActiveGiveaway?.(msgId);
            if (saved) {
              entrants = new Set(saved.entrants || []);
              global.giveawayEntrants.set(msgId, entrants);
            }
          }
          if (action === 'gaw_alt_dismiss') {
            await interaction.update({ components: [] }).catch(() => interaction.deferUpdate());
            return;
          }
          if (!entrants) {
            return interaction.reply({ content: 'Giveaway no longer active.', flags: EPHEMERAL_FLAG }).catch(() => {});
          }
          const removeOne = (uid) => { entrants.delete(uid); };
          if (action === 'gaw_alt_remove') {
            removeOne(userId);
          } else if (action === 'gaw_alt_remove_cohort') {
            removeOne(userId);
            // remove other young accounts currently in the set
            try {
              const anti = require('../utils/giveawayAntiAlt');
              const analysis = anti.evaluateEntrant(interaction.guild, [...entrants, userId], userId);
              for (const id2 of analysis.cohort) removeOne(id2);
            } catch {}
          }
          client.commands.get('giveaway')?.persistGiveawayEntry?.(msgId, entrants);
          try {
            await client.commands.get('giveaway')?.refreshLiveGiveawayMessage?.(
              interaction.guild, msgId, entrants.size,
            );
          } catch (err) {
            console.warn('[GIVEAWAY] alt-remove refresh:', err.message);
          }
          await interaction.update({
            content: interaction.message.content || null,
            embeds: interaction.message.embeds,
            components: [],
          }).catch(() => {});
          return interaction.followUp({
            content: `Removed. **${entrants.size}** entries remain.`,
            flags: EPHEMERAL_FLAG,
          }).catch(() => {});
        }
        // Giveaway entry, in one place for both doors in: the Enter button on
        // the drop, and "Finish verification" on the private check card.
        // Returns the private line to show, and does the entering.
        const giveawayEnterFor = async (msgId) => {
          if (!global.giveawayEntrants) global.giveawayEntrants = new Map();
          let entrants = global.giveawayEntrants.get(msgId);

          // Not in memory — bot may have restarted during a long giveaway.
          // Check persisted active-giveaway state before declaring it ended.
          if (!entrants) {
            const giveawayCmd = client.commands.get('giveaway');
            const saved = giveawayCmd?.getActiveGiveaway?.(msgId);
            if (saved && saved.endTime > Date.now()) {
              if (!global.giveawayMeta) global.giveawayMeta = new Map();
              entrants = new Set(saved.entrants || []);
              global.giveawayEntrants.set(msgId, entrants);
              global.giveawayMeta.set(msgId, {
                prize: saved.prize, winners: saved.winnersCount, imageUrl: saved.imageUrl,
                hostId: saved.hostId, endTime: saved.endTime, guildId: saved.guildId,
                requiredRoleId: saved.requiredRoleId || null, bonusRoleId: saved.bonusRoleId || null,
                minAccountAgeDays: saved.minAccountAgeDays || 0,
                requirementLines: saved.requirementLines || [],
                dropId: saved.dropId || null,
                channelId: saved.channelId || null,
              });
            }
          }

          if (!entrants) return { done: true, text: 'This giveaway has ended.' };
          if (entrants.has(interaction.user.id)) return { done: true, text: "You've already entered!" };

          const gawMeta = global.giveawayMeta?.get(msgId);
          if (gawMeta?.requiredRoleId && !interaction.member.roles.cache.has(gawMeta.requiredRoleId)) {
            return { done: true, text: `❌ You need the <@&${gawMeta.requiredRoleId}> role to enter this giveaway.` };
          }
          if (gawMeta?.minAccountAgeDays > 0) {
            const ageDays = (Date.now() - interaction.user.createdTimestamp) / 86400000;
            if (ageDays < gawMeta.minAccountAgeDays) {
              return { done: true, text: `❌ Your account must be at least **${gawMeta.minAccountAgeDays} days** old to enter this giveaway.` };
            }
          }

          // The alt check (utils/entryVerify.js). A member already verified in
          // this server goes straight in; everyone else gets the check card.
          const ev = require('../utils/entryVerify');
          if (ev.isEnabled(interaction.guildId)) {
            // Per giveaway: passing the check for one drop does not cover the next.
            const st = ev.statusOf(interaction.guildId, interaction.user.id, msgId);
            if (st === 'flagged') return { done: true, held: true, meta: gawMeta };
            if (st !== 'verified') return { done: false, needsVerify: true, meta: gawMeta };
          }

          entrants.add(interaction.user.id);
          try {
            const anti = require('../utils/giveawayAntiAlt');
            const ids = [...entrants];
            const analysis = anti.evaluateEntrant(interaction.guild, ids, interaction.user.id);
            if (analysis.suspicious) {
              const meta = global.giveawayMeta?.get(msgId);
              anti.reportSuspicious(interaction.guild, {
                messageId: msgId,
                dropId: meta?.dropId,
                prize: meta?.prize,
                userId: interaction.user.id,
                analysis,
              }).catch(() => {});
            }
          } catch (err) {
            console.warn('[GIVEAWAY ANTI-ALT]', err.message);
          }

          // Persist first, then refresh the V2 card (same path as panel remove).
          // This keeps Entries live on first enter AND after remove → re-enter.
          client.commands.get('giveaway')?.persistGiveawayEntry?.(msgId, entrants);
          try {
            await client.commands.get('giveaway')?.refreshLiveGiveawayMessage?.(
              interaction.guild,
              msgId,
              entrants.size,
            );
          } catch (err) {
            console.warn('[GIVEAWAY] enter refresh:', err.message);
          }
          return { done: true, entered: true, text: '🎟️ You\'ve entered the giveaway! Good luck!', meta: gawMeta };
        };

        if (id === 'giveaway_enter') {
          const out = await giveawayEnterFor(interaction.message.id);
          const vc = require('../utils/entryVerifyCard');
          if (out.needsVerify) {
            return interaction.reply(vc.checkCard(interaction, interaction.message.id, interaction.channelId, out.meta));
          }
          if (out.held) return interaction.reply(vc.heldCard(interaction, out.meta));
          if (out.entered) return interaction.reply(vc.enteredCard(interaction, out.meta, interaction.message.id));
          return interaction.reply({ content: out.text, flags: EPHEMERAL_FLAG });
        }

        // "Finish verification" on the private check card: enters the member
        // if the page verified them, and says why not if it did not.
        if (id.startsWith('gaw_vdone:')) {
          const msgId = id.split(':')[1];
          const vc = require('../utils/entryVerifyCard');
          const out = await giveawayEnterFor(msgId);
          if (out.needsVerify) {
            return interaction.update(vc.forUpdate(vc.checkCard(interaction, msgId, out.meta?.channelId || interaction.channelId, out.meta, { notYet: true }))).catch(() => {});
          }
          if (out.held) return interaction.update(vc.forUpdate(vc.heldCard(interaction, out.meta))).catch(() => {});
          if (out.entered) return interaction.update(vc.forUpdate(vc.enteredCard(interaction, out.meta, msgId))).catch(() => {});
          return interaction.update(vc.forUpdate(vc.noteCard(out.text))).catch(() => {});
        }

        // Giveaway — Check my entry (private plain text, entry number only)
        if (id === 'giveaway_check') {
          if (!global.giveawayEntrants) global.giveawayEntrants = new Map();
          let entrants = global.giveawayEntrants.get(interaction.message.id);
          if (!entrants) {
            const giveawayCmd = client.commands.get('giveaway');
            const saved = giveawayCmd?.getActiveGiveaway?.(interaction.message.id);
            if (saved && saved.endTime > Date.now()) {
              entrants = new Set(saved.entrants || []);
              global.giveawayEntrants.set(interaction.message.id, entrants);
            }
          }
          if (!entrants) {
            return interaction.reply({ content: 'This drop has already closed.', flags: EPHEMERAL_FLAG });
          }
          if (!entrants.has(interaction.user.id)) {
            return interaction.reply({
              content: "You're not in this drop yet — hit **ENTER DROP** first.",
              flags: EPHEMERAL_FLAG,
            });
          }
          // Prefer the persisted ordered array so entry numbers stay stable
          // across restarts (Set insertion order alone is not enough if data
          // was reloaded in a different shape).
          const giveawayCmd = client.commands.get('giveaway');
          const saved = giveawayCmd?.getActiveGiveaway?.(interaction.message.id);
          const list = Array.isArray(saved?.entrants) && saved.entrants.length
            ? saved.entrants
            : Array.from(entrants);
          const number = list.indexOf(interaction.user.id) + 1;
          const total = list.length;
          const gawMeta = global.giveawayMeta?.get(interaction.message.id);
          const prize = gawMeta?.prize ? ` for **${gawMeta.prize}**` : '';
          const lines = [
            `🎟️ You're locked in${prize}.`,
            ``,
            `Your entry number is **#${number}** of ${total}.`,
            ``,
            `Stay sharp — winners are drawn when the timer hits zero.`,
          ];
          return interaction.reply({ content: lines.join('\n'), flags: EPHEMERAL_FLAG });
        }

        // Giveaway — Reveal (host / manage server only)
        if (id === 'giveaway_reveal') {
          const giveawayCmd = client.commands.get('giveaway');
          const r = await giveawayCmd?.revealGiveaway?.(interaction.message, interaction);
          if (!r?.ok) {
            const why = {
              unknown_giveaway: 'This drop is not open for results.',
              already_opened: 'You already opened this box.',
              already_revealed: 'You already opened this box.',
              not_allowed: 'You cannot open this box.',
            }[r?.error] || 'Could not open the box.';
            return interaction.reply({ content: why, flags: EPHEMERAL_FLAG });
          }
          return interaction.reply({
            content: r.content || r.body || 'Result',
            flags: EPHEMERAL_FLAG,
          });
        }

        // Giveaway — participants (first page)
        if (id === 'giveaway_participants') {
          const giveawayMsgId = interaction.message.id;
          const { embed, totalPages, currentPage } = buildParticipantsEmbed(giveawayMsgId, 1);
          const row = buildParticipantsRow(giveawayMsgId, currentPage, totalPages);
          return await interaction.reply({ embeds: [embed], components: [row], flags: EPHEMERAL_FLAG });
        }

        // Giveaway — prev/next page (updates in-place, no new message)
        if (id.startsWith('gaw_p:') || id.startsWith('gaw_n:')) {
          const [, giveawayMsgId, pageStr] = id.split(':');
          const currentPage = parseInt(pageStr);
          const newPage     = id.startsWith('gaw_p:') ? currentPage - 1 : currentPage + 1;
          const { embed, totalPages, currentPage: safePage } = buildParticipantsEmbed(giveawayMsgId, newPage);
          const row = buildParticipantsRow(giveawayMsgId, safePage, totalPages);
          return await interaction.update({ embeds: [embed], components: [row] });
        }

        // Coins giveaways were removed with the economy. Their old messages can
        // still be clicked; answer instead of letting it end in "interaction failed".
        if (id.startsWith('cg_') || id.startsWith('coinsgaw_') || id.startsWith('cg_list_')) {
          return await interaction.reply({ content: 'This giveaway is no longer active.', flags: EPHEMERAL_FLAG }).catch(() => {});
        }

    // ── yserbot lines 559-572: verification buttons ──
        // Verification — memory-sequence challenge
        if (id === 'verify_start') {
          return await client.commands.get('verify')?.handleStart(interaction);
        }
        if (id.startsWith('verify_ready:')) {
          return await client.commands.get('verify')?.handleReady(interaction, id.slice('verify_ready:'.length));
        }
        if (id.startsWith('verify_pick:')) {
          const [, sessionId, idxStr] = id.split(':');
          return await client.commands.get('verify')?.handlePick(interaction, sessionId, parseInt(idxStr, 10));
        }
        if (id.startsWith('verify_cancel:')) {
          return await client.commands.get('verify')?.handleCancel(interaction, id.slice('verify_cancel:'.length));
        }

  } catch (err) {
    if (isUnknownInteractionError(err)) return;
    reportAndLog(err, { area: 'Button interaction', customId: id, guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user?.id });
    const rep = { embeds: [embedUtil.error('Error', 'An unexpected error occurred.')], flags: EPHEMERAL_FLAG };
    if (interaction.replied || interaction.deferred) await interaction.followUp(rep).catch(() => {});
    else await interaction.reply(rep).catch(() => {});
  }
}

async function handleModal(interaction, client) {
  const id = interaction.customId;
  try {
    if (id.startsWith('gaw_modal:')) return await client.commands.get('giveaway')?.handleSetupModal(interaction);
    if (id === 'verify_rules_modal') return await client.commands.get('verify')?.handleRulesModal(interaction);
  } catch (err) {
    if (isUnknownInteractionError(err)) return;
    reportAndLog(err, { area: 'Modal', customId: id });
    const rep = { embeds: [embedUtil.error('Error', 'An unexpected error occurred.')], flags: EPHEMERAL_FLAG };
    if (interaction.replied || interaction.deferred) await interaction.followUp(rep).catch(() => {});
    else await interaction.reply(rep).catch(() => {});
  }
}

async function handleSelect(interaction, client) {
  const id = interaction.customId;
  try {
    if (interaction.isStringSelectMenu() && id === 'gaw_list_delsel') return await client.commands.get('giveaway')?.handleListSelect(interaction);
    if (interaction.isRoleSelectMenu() && id.startsWith('gaw_role_select:')) return await client.commands.get('giveaway')?.handleRoleSelect(interaction);
    if (interaction.isChannelSelectMenu() && id.startsWith('gaw_channel_select:')) return await client.commands.get('giveaway')?.handleChannelSelect(interaction);
  } catch (err) {
    if (isUnknownInteractionError(err)) return;
    reportAndLog(err, { area: 'Select', customId: id });
    const rep = { embeds: [embedUtil.error('Error', 'An unexpected error occurred.')], flags: EPHEMERAL_FLAG };
    if (interaction.replied || interaction.deferred) await interaction.followUp(rep).catch(() => {});
    else await interaction.reply(rep).catch(() => {});
  }
}

async function handleCommand(interaction, client) {
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  try { await command.execute(interaction, client); } catch (err) {
    if (isUnknownInteractionError(err)) return;
    reportAndLog(err, { area: 'Slash command', customId: interaction.commandName });
    const reply = { embeds: [embedUtil.error('Error', 'An unexpected error occurred.')], flags: EPHEMERAL_FLAG };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
}

async function handleAutocomplete(interaction, client) {
  const command = client.commands.get(interaction.commandName);
  if (command?.autocomplete) { try { await command.autocomplete(interaction); } catch (err) { if (err.code !== 10062) console.error('[AC ERROR]', interaction.commandName, err); } }
}

module.exports = { handleButton, handleModal, handleSelect, handleCommand, handleAutocomplete };
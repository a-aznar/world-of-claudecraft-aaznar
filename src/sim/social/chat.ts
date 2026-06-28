// Player chat plumbing (G2), extracted verbatim from the Sim monolith behind
// SimContext. The big chat() slash-command + channel ROUTER stays on Sim as
// coordinator code: it dispatches over ~40 Sim-private `*Readout` formatters that
// have not been extracted, so moving it would either balloon the seam or reach
// back into Sim internals (both forbidden by the SimContext contract). This module
// holds the self-contained chat HELPERS chat() dispatches to: the token-bucket
// throttle, the dev-chat cheats, whisper name resolution, the emote broadcaster,
// the /join /leave channel handler, and the /help + /inspect readouts. The chat
// token + channel-subscription state stays Sim-owned (live ctx views: `chatTokens`,
// `channelSubs`); the leave-path cleanup reaches them through the same seam.
//
// This is a MOVE: statements, branches, regexes, and iteration order are
// byte-identical to the pre-move methods. None of these helpers draw rng. Player
// emit literals stay at the emit site (the S3 i18n guard scans this file).

import { CLASSES, ITEMS } from '../data';
import {
  JOINABLE_CHANNELS,
  type JoinableChannel,
  MAX_CHAT_MESSAGE_LEN,
  type PlayerMeta,
  SAY_RANGE,
  type SentChat,
} from '../sim';
import type { SimContext } from '../sim_context';
import { dist2d, type Entity, MAX_LEVEL, type OverheadEmoteId } from '../types';

const CHAT_BURST = 8; // messages a player may send back-to-back...
const CHAT_REFILL = 2; // ...then this many more per second (caps spam amplifiers)
const OVERHEAD_EMOTE_DURATION = 3.2;

// Token-bucket throttle: returns false (and notifies the player once) when
// they are out of chat tokens. Keeps /g and /w from being spam amplifiers.
export function chatAllowed(ctx: SimContext, pid: number): boolean {
  let b = ctx.chatTokens.get(pid);
  if (!b) {
    b = { tokens: CHAT_BURST, at: ctx.time };
    ctx.chatTokens.set(pid, b);
  }
  b.tokens = Math.min(CHAT_BURST, b.tokens + (ctx.time - b.at) * CHAT_REFILL);
  b.at = ctx.time;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Dev chat cheats — only when Sim.devCommands is enabled (offline local play
// or online server with ALLOW_DEV_COMMANDS=1). Returns null when handled
// (no channel message), or undefined when not a dev command.
export function handleDevChat(
  ctx: SimContext,
  raw: string,
  pid: number,
): SentChat | null | undefined {
  const levelM = /^\/(?:dev\s+level|devlevel)\s+(\d+)\s*$/i.exec(raw);
  if (levelM) {
    const level = Number(levelM[1]);
    ctx.setPlayerLevel(level, pid);
    ctx.emit({
      type: 'log',
      text: `[dev] Level set to ${Math.max(1, Math.min(MAX_LEVEL, level))}.`,
      pid,
    });
    return null;
  }
  const tpM = /^\/(?:dev\s+tp|devtp)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*$/i.exec(raw);
  if (tpM) {
    const e = ctx.entities.get(pid);
    if (e) {
      const p = ctx.groundPos(Number(tpM[1]), Number(tpM[2]));
      e.pos = p;
      e.prevPos = { ...p };
      ctx.grid.update(e);
      ctx.playerGrid.update(e);
      ctx.emit({
        type: 'log',
        text: `[dev] Teleported to ${p.x.toFixed(1)}, ${p.z.toFixed(1)}.`,
        pid,
      });
    }
    return null;
  }
  const giveM = /^\/(?:dev\s+give|devgive)\s+(\S+)(?:\s+(\d+))?\s*$/i.exec(raw);
  if (giveM) {
    const itemId = giveM[1];
    const count = Math.max(1, Math.min(20, Number(giveM[2] ?? 1)));
    if (!ITEMS[itemId]) {
      ctx.error(pid, `[dev] Unknown item '${itemId}'.`);
      return null;
    }
    ctx.addItem(itemId, count, pid);
    return null;
  }
  const questM = /^\/(?:dev\s+quest|devquest)\s+(\S+)\s*$/i.exec(raw);
  if (questM) {
    ctx.completeQuestForDev(questM[1], pid);
    return null;
  }
  const questAllM = /^\/(?:dev\s+(?:quests|questall)|devquestall)\s*$/i.exec(raw);
  if (questAllM) {
    ctx.completeCurrentQuestsForDev(pid);
    return null;
  }
  if (/^\/dev(?:\s|$)/i.test(raw)) {
    ctx.error(pid, 'Dev commands: /dev level N, /dev tp X Z, /dev give itemId [count]');
    return null;
  }
  return undefined;
}

export function whisperMessageForName(
  rest: string,
  name: string,
  exactCase: boolean,
): string | null {
  const input = exactCase ? rest : rest.toLowerCase();
  const prefix = exactCase ? name : name.toLowerCase();
  if (!input.startsWith(prefix)) return null;
  const next = rest.charAt(name.length);
  if (!next || !/\s/.test(next)) return null;
  const message = rest.slice(name.length).trim();
  return message ? message : null;
}

export function resolveWhisperTarget(
  ctx: SimContext,
  rest: string,
): { target: PlayerMeta; message: string } | { error: string } | null {
  const trimmed = rest.trim();
  if (!trimmed) return null;
  const matches: { target: PlayerMeta; message: string; exactCase: boolean }[] = [];
  for (const target of ctx.players.values()) {
    const exactMessage = whisperMessageForName(trimmed, target.name, true);
    if (exactMessage !== null) {
      matches.push({ target, message: exactMessage, exactCase: true });
      continue;
    }
    const insensitiveMessage = whisperMessageForName(trimmed, target.name, false);
    if (insensitiveMessage !== null)
      matches.push({ target, message: insensitiveMessage, exactCase: false });
  }
  matches.sort((a, b) => b.target.name.length - a.target.name.length);
  const longestLength = matches[0]?.target.name.length ?? 0;
  const longest = matches.filter((m) => m.target.name.length === longestLength);
  const exact = longest.filter((m) => m.exactCase);
  if (exact.length > 0) return exact[0];
  if (longest.length === 1) return longest[0];
  const typedName = trimmed.split(/\s+/, 1)[0] ?? trimmed;
  if (longest.length > 1)
    return { error: `Several players match '${typedName}'. Use exact capitalization.` };
  return { error: `There is no player named '${typedName}' online.` };
}

// Resolve a player by name the same way whispers do: an exact-case match
// wins outright, otherwise a case-insensitive match is used only when it is
// unambiguous.
export function findPlayerByName(ctx: SimContext, name: string): PlayerMeta | null {
  const wanted = name.toLowerCase();
  const ci: PlayerMeta[] = [];
  for (const meta of ctx.players.values()) {
    if (meta.name === name) return meta;
    if (meta.name.toLowerCase() === wanted) ci.push(meta);
  }
  return ci.length === 1 ? ci[0] : null;
}

// Send a third-person emote to every player within /say range (including the
// actor). `from` carries the actor's name so the client can render it as a
// clickable name; `text` is the action predicate (e.g. "waves at Bet.").
export function broadcastEmote(
  ctx: SimContext,
  actor: PlayerMeta,
  actorEntity: Entity,
  text: string,
): void {
  const body = text.slice(0, MAX_CHAT_MESSAGE_LEN);
  for (const meta of ctx.players.values()) {
    const e = ctx.entities.get(meta.entityId);
    if (!e || dist2d(actorEntity.pos, e.pos) > SAY_RANGE) continue;
    ctx.emit({
      type: 'chat',
      fromPid: actor.entityId,
      from: actor.name,
      text: body,
      channel: 'emote',
      entityId: actorEntity.id,
      pid: meta.entityId,
    });
  }
}

export function playEmote(ctx: SimContext, emoteId: OverheadEmoteId, pid?: number): void {
  const r = ctx.resolve(pid);
  if (!r) return;
  r.e.overheadEmoteId = emoteId;
  r.e.overheadEmoteUntil = ctx.time + OVERHEAD_EMOTE_DURATION;
  r.e.overheadEmoteSeq += 1;
}

// Lines shown by the "/help" command, one system notice per entry. Keep this
// in sync with the commands handled in chat() above.
export function helpLines(): string[] {
  return [
    'Chat channels: /s say, /y yell, /general, /p party, /world, /lfg.',
    'Whisper a player with /w <name> <message>, reply with /r.',
    'Other commands: /join <world|lfg>, /roll, /inspect <name>, /follow <name>, /unfollow, /assist <name>, /afk, /dnd, /who.',
    'Character readouts: /played, /xp, /gold, /stats, /bags, /gear, /abilities, /buffs, /cooldowns, /quest, /completed.',
    'World readouts: /where, /zones, /nearby, /pois, /graveyard, /dungeons, /arena, /session, /listings, /buyback.',
    'Combat readouts: /target, /targetbuffs, /range, /attack, /casting, /combat, /threat, /consider, /combo, /overpower.',
    'State readouts: /pet, /pettaunt, /speed, /consumable, /potion, /form, /manaregen, /falling, /queued, /savedmana.',
  ];
}

// One-line readout for /inspect: another player's level, class, and health.
export function inspectReadout(target: PlayerMeta, e: Entity): string {
  const cls = CLASSES[target.cls]?.name ?? target.cls;
  const hp = e.hp <= 0 ? 'dead' : `${Math.round(Math.max(0, Math.min(1, e.hp / e.maxHp)) * 100)}%`;
  return `${target.name}: Level ${e.level} ${cls} — HP ${hp}.`;
}

// Handles /join and /leave for the opt-in global channels.
export function handleChannelMembership(
  ctx: SimContext,
  meta: PlayerMeta,
  action: 'join' | 'leave',
  arg: string,
): void {
  const pid = meta.entityId;
  if (!arg) {
    ctx.error(pid, `Usage: /${action} <channel>. Channels: ${JOINABLE_CHANNELS.join(', ')}.`);
    return;
  }
  if (arg === 'general') {
    ctx.error(pid, 'The General channel is always on - just use /general.');
    return;
  }
  if (!JOINABLE_CHANNELS.includes(arg as JoinableChannel)) {
    ctx.error(
      pid,
      `There is no channel named '${arg}'. Channels: ${JOINABLE_CHANNELS.join(', ')}.`,
    );
    return;
  }
  const channel = arg as JoinableChannel;
  let set = ctx.channelSubs.get(pid);
  if (action === 'join') {
    if (!set) {
      set = new Set();
      ctx.channelSubs.set(pid, set);
    }
    if (set.has(channel)) {
      ctx.error(pid, `You are already in the ${channel} channel.`);
      return;
    }
    set.add(channel);
    ctx.notice(pid, `Joined the ${channel} channel. Type /${channel} <message> to talk.`);
  } else {
    if (!set?.has(channel)) {
      ctx.error(pid, `You are not in the ${channel} channel.`);
      return;
    }
    set.delete(channel);
    if (set.size === 0) ctx.channelSubs.delete(pid);
    ctx.notice(pid, `Left the ${channel} channel.`);
  }
}

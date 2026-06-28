import { QUESTS, questRewardItemId } from '../data';
import { formatMoney } from '../format_money';
import { questFallbackGrants } from '../quest_fallback';
import type { PlayerMeta } from '../sim';
import type { SimContext } from '../sim_context';
import type { QuestDef, QuestProgress } from '../types';

export function acceptQuestCore(
  ctx: SimContext,
  questId: string,
  quest: QuestDef,
  meta: PlayerMeta,
): void {
  meta.questLog.set(questId, { questId, counts: quest.objectives.map(() => 0), state: 'active' });
  for (const itemId of questFallbackGrants(
    quest,
    (id) => ctx.countItem(id, meta.entityId) > 0,
  )) {
    ctx.addItem(itemId, 1, meta.entityId);
  }
  ctx.emit({ type: 'questAccepted', questId, pid: meta.entityId });
  ctx.emit({
    type: 'log',
    text: `Quest accepted: ${quest.name}`,
    color: '#ff0',
    pid: meta.entityId,
  });
  ctx.onInventoryChangedForQuests(meta);
}

export function turnInQuestCore(
  ctx: SimContext,
  questId: string,
  quest: QuestDef,
  meta: PlayerMeta,
): void {
  const qp = meta.questLog.get(questId);
  if (!qp) {
    ctx.error(meta.entityId, 'That quest is not in your log.');
    return;
  }
  if (qp.state !== 'ready') {
    ctx.error(meta.entityId, 'That quest is not complete.');
    return;
  }
  for (const obj of quest.objectives) {
    if (obj.type === 'collect' && obj.itemId) ctx.removeItem(obj.itemId, obj.count, meta.entityId);
  }
  qp.state = 'done';
  meta.questLog.delete(questId);
  meta.questsDone.add(questId);
  meta.counters.questsCompleted++;
  if (quest.copperReward > 0) {
    meta.copper += quest.copperReward;
    ctx.emit({
      type: 'loot',
      text: `You receive ${formatMoney(quest.copperReward)}.`,
      pid: meta.entityId,
    });
  }
  const rewardItem = questRewardItemId(quest, meta.cls);
  if (rewardItem) ctx.addItem(rewardItem, 1, meta.entityId);
  ctx.grantXp(quest.xpReward, meta);
  ctx.emit({ type: 'questDone', questId, pid: meta.entityId });
  ctx.emit({
    type: 'log',
    text: `Quest completed: ${quest.name}`,
    color: '#ff0',
    pid: meta.entityId,
  });
}

function satisfyTrackedQuestForDev(ctx: SimContext, quest: QuestDef, qp: QuestProgress, meta: PlayerMeta): void {
  let collectChanged = false;
  quest.objectives.forEach((obj, index) => {
    if (obj.type === 'collect' && obj.itemId) {
      const have = ctx.countItem(obj.itemId, meta.entityId);
      if (have < obj.count) {
        ctx.addItem(obj.itemId, obj.count - have, meta.entityId);
        collectChanged = true;
      }
      return;
    }
    const next = Math.max(qp.counts[index] ?? 0, obj.count);
    if (next !== qp.counts[index]) {
      meta.counters.questProgress += next - (qp.counts[index] ?? 0);
      qp.counts[index] = next;
      ctx.emit({
        type: 'questProgress',
        questId: qp.questId,
        text: `${obj.label}: ${qp.counts[index]}/${obj.count}`,
        pid: meta.entityId,
      });
    }
  });
  if (collectChanged) ctx.onInventoryChangedForQuests(meta);
  ctx.checkQuestReady(qp, meta);
}

function trackedQuestForDev(
  ctx: SimContext,
  questId: string,
  meta: PlayerMeta,
): { quest: QuestDef; qp: QuestProgress } | null {
  const active = meta.questLog.get(questId);
  const quest = QUESTS[questId];
  if (active && quest) return { quest, qp: active };
  if (!quest) {
    ctx.error(meta.entityId, 'That quest is not available.');
    return null;
  }
  if (ctx.questState(questId, meta.entityId) !== 'available') {
    ctx.error(meta.entityId, 'That quest is not available.');
    return null;
  }
  acceptQuestCore(ctx, questId, quest, meta);
  const qp = meta.questLog.get(questId);
  if (!qp) {
    ctx.error(meta.entityId, 'That quest is not in your log.');
    return null;
  }
  return { quest, qp };
}

function completeTrackedQuestForDev(ctx: SimContext, questId: string, meta: PlayerMeta): boolean {
  const tracked = trackedQuestForDev(ctx, questId, meta);
  if (!tracked) return false;
  satisfyTrackedQuestForDev(ctx, tracked.quest, tracked.qp, meta);
  if (tracked.qp.state !== 'ready') {
    ctx.error(meta.entityId, 'That quest is not complete.');
    return false;
  }
  turnInQuestCore(ctx, questId, tracked.quest, meta);
  return meta.questsDone.has(questId);
}

export function completeQuestForDev(ctx: SimContext, questId: string, pid?: number): boolean {
  const r = ctx.resolve(pid);
  if (!r) return false;
  return completeTrackedQuestForDev(ctx, questId, r.meta);
}

export function completeCurrentQuestsForDev(ctx: SimContext, pid?: number): number {
  const r = ctx.resolve(pid);
  if (!r) return 0;
  const ids = [...r.meta.questLog.keys()];
  if (ids.length === 0) {
    ctx.error(r.meta.entityId, 'Your quest log is empty.');
    return 0;
  }
  let completed = 0;
  for (const questId of ids) {
    if (completeTrackedQuestForDev(ctx, questId, r.meta)) completed++;
  }
  return completed;
}

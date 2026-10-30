/**
 * Achievement tracking, limited to what the save can actually prove.
 *
 * The rule here is stricter than for progress axes. An achievement list is
 * useless if it guesses: telling someone they are "close to 100%" when the
 * number is invented is worse than saying nothing. So every entry declares how
 * it is verified, and entries the save cannot settle are reported as
 * unverifiable rather than estimated.
 *
 * What the save does NOT contain, confirmed by inspection rather than assumed:
 *   - gestures (the region the layout suggests holds an extra item table,
 *     not a gesture list: the "count" there is followed by item ids 400101,
 *     300001, ...)
 *   - covenant rank (only unspent turn-in tokens are stored; how many were
 *     already handed in is not, so "rank 2 needs 20 more" cannot be derived)
 *   - estus / bone shard totals (consumed on pickup, no counter remains)
 * Those are reported as unverifiable instead of being guessed at.
 */
import { COVENANT_SPELLS } from './reachability.js'

/** The 15 infusion gems; "Master of Infusion" needs every kind obtained. */
export const INFUSION_GEMS = [
  'Heavy Gem', 'Sharp Gem', 'Refined Gem', 'Crystal Gem', 'Simple Gem',
  'Fire Gem', 'Chaos Gem', 'Lightning Gem', 'Deep Gem', 'Dark Gem',
  'Poison Gem', 'Blood Gem', 'Raw Gem', 'Blessed Gem', 'Hollow Gem',
]

/** The 8 covenants, by the ring-table entry that records membership. */
export const COVENANTS = [
  'Way of Blue', 'Blade of the Darkmoon', 'Blue Sentinels', 'Watchdogs of Farron',
  'Aldrich Faithful', "Rosaria's Fingers", 'Mound-makers', 'Warrior of Sunlight',
]

const RING_COVENANT_RANGE = [536880000, 536890000]

/**
 * @param {object} args
 * @param {Set<number>} args.owned        item ids in the bag
 * @param {Set<string>} args.bagNames     display names in the bag
 * @param {Record<string,string>} args.rings  ring reference table
 * @param {object} args.axes              output of buildAxes
 * @param {object} args.bosses            { killed, total }
 */
export function achievementStatus({ owned, bagNames, rings, axes, bosses, steam = null }) {
  const entries = []

  // Steam's own achievements replace any estimate. When the Steam data is
  // present it is the authority; the item-derived axes stay as a cross-check.
  if (steam?.items?.length) {
    const done = steam.items.filter((a) => a.unlocked).length
    entries.push({
      id: 'steam-achievements',
      name: 'Steam 成就',
      group: 'steam',
      verifiable: true,
      have: done,
      total: steam.items.length,
      missing: steam.items.filter((a) => !a.unlocked).map((a) => a.name ?? a.api),
      note: `来自 Steam 客户端的本地成就记录（${steam.persona ?? '未识别账号'}），解锁时间跨周目保留。`,
    })
  }

  // --- verifiable: derived from item ids and boss flags -------------------
  entries.push({
    id: 'all-bosses',
    name: '全 Boss 击败',
    group: 'boss',
    verifiable: true,
    have: bosses.killed,
    total: bosses.total,
    missing: bosses.alive ?? [],
    note: '只覆盖已收录的 24 个主线与 DLC 主要 Boss，不含小 Boss。',
  })

  const gemHave = INFUSION_GEMS.filter((g) => bagNames.has(g))
  const gemMissing = INFUSION_GEMS.filter((g) => !bagNames.has(g))
  entries.push({
    id: 'all-gems',
    name: '全部 15 种质变宝石',
    group: 'infusion',
    verifiable: true,
    have: gemHave.length,
    total: INFUSION_GEMS.length,
    missing: gemMissing,
    note: '宝石用掉后仍算已获得，但存档只记背包，已用完的可能不显示。',
  })

  const covOwned = COVENANTS.filter((name) => {
    const id = Object.keys(rings).find((k) => {
      const n = Number(k)
      return n >= RING_COVENANT_RANGE[0] && n < RING_COVENANT_RANGE[1] && rings[k] === name
    })
    return id && owned.has(Number(id))
  })
  entries.push({
    id: 'all-covenants',
    name: '加入全部 8 个誓约',
    group: 'covenant',
    verifiable: true,
    have: covOwned.length,
    total: COVENANTS.length,
    missing: COVENANTS.filter((c) => !covOwned.includes(c)),
    note: '按誓约徽章判定；加入即算，不要求等级。',
  })

  // Spells, split by whether a covenant gates them.
  const spellEntries = []
  const covLocked = []
  for (const [school, data] of Object.entries(axes.spells)) {
    spellEntries.push({ school, have: data.have, total: data.total })
    for (const name of data.missing) {
      if (COVENANT_SPELLS[name]) covLocked.push({ name, covenant: COVENANT_SPELLS[name] })
    }
  }
  entries.push({
    id: 'all-spells',
    name: '全部 108 个法术',
    group: 'spell',
    verifiable: true,
    have: spellEntries.reduce((s, r) => s + r.have, 0),
    total: spellEntries.reduce((s, r) => s + r.total, 0),
    missing: [],
    bySchool: spellEntries,
    covenantLocked: covLocked,
    note: '按背包判定。教团奖励清单不完整，只有已确认的 5 个标注了归属。',
  })

  // --- ring tiers: a collectible ring set needs base + upgrades -----------
  entries.push({
    id: 'all-rings',
    name: '全部戒指',
    group: 'ring',
    verifiable: true,
    have: axes.rings.have,
    total: axes.rings.total,
    missing: axes.rings.missingFamilies,
    note: '按家族计，+1/+2/+3 是同一枚戒指。',
  })

  // --- not verifiable, stated as such -------------------------------------
  entries.push({
    id: 'all-gestures',
    name: '全部姿势',
    group: 'gesture',
    verifiable: false,
    reason: '存档里没有姿势清单。布局中的“计数”字段后面跟的是物品 ID 表，不是姿势列表——已实测确认。',
  })
  entries.push({
    id: 'covenant-ranks',
    name: '誓约等级（各 2 级）',
    group: 'covenant',
    verifiable: false,
    reason: '存档只记当前持有的誓约道具，不记已上交数量，所以“距下一级还差几个”无法推导。',
  })
  entries.push({
    id: 'max-estus',
    name: '元素瓶 / 不死骨灰上限',
    group: 'item',
    verifiable: false,
    reason: '碎片在拾取时即被消耗，存档不留计数器。',
  })
  // Endings have their own module, which reports per-ending what the save
  // shows. Listing them here as unverifiable would contradict it.
  entries.push({
    id: 'endings',
    name: '全部结局',
    group: 'story',
    verifiable: false,
    reason: '结局的达成记录只存在于 Steam 成就里（见上面那一条）；存档分辨不出。四个结局里前三个可查 Steam，夺火没有任何记录，逐项状态见结局区块。',
  })

  const verifiable = entries.filter((e) => e.verifiable)
  const done = verifiable.filter((e) => e.have >= e.total)
  return {
    entries,
    summary: {
      verifiable: verifiable.length,
      complete: done.length,
      unverifiable: entries.length - verifiable.length,
    },
  }
}

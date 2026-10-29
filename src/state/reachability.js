/**
 * Reachability: turning "35 rings missing" into "these you can get now".
 *
 * The rule this module follows: every verdict must name its evidence. A gap is
 * only ever labelled with something the save or the reference table actually
 * proves — an item in the bag, a boss flag, a covenant token count, a ring tier.
 * Whenever that evidence is absent the verdict is `unknown`, never a guess.
 *
 * Why it matters: a flat list of 35 missing rings reads as 35 equal tasks. In
 * fact two of them need NG+, five spells are locked behind covenant ranks, and
 * the rest are ordinary pickups. Collapsing that distinction is what made the
 * panel useless for deciding what to do next.
 */

/**
 * Boss-soul transposition: you must beat the boss, then still hold its soul.
 *
 * Only bosses are listed. `Soul of a Demon` and `Soul of a Crestfallen Knight`
 * come from ordinary enemies and transpose into nothing, so including them
 * would produce a confident answer that is wrong.
 */
export const SOUL_SOURCES = {
  'Soul of Aldrich': '吞噬神明的艾尔德利奇',
  'Soul of Yhorm the Giant': '巨人尤姆',
  'Soul of the Nameless King': '无名之王',
  'Soul of the Twin Princes': '双子王子',
  'Soul of the Old Demon King': '老恶魔王',
  'Soul of Sister Friede': '修女芙莉德',
  'Soul of the Demon Prince': '恶魔王子',
  'Soul of Darkeater Midir': '吞噬黑暗的米狄尔',
  'Soul of Slave Knight Gael': '奴隶骑士盖尔',
  'Soul of the Lords': '薪王们的化身',
}

/** Covenant rank rewards. Threshold is the token count the rank needs. */
export const COVENANT_REWARDS = {
  'Warrior of Sunlight': { token: 'Sunlight Medal', rank1: 10, rank2: 30 },
  'Blade of the Darkmoon': { token: 'Proof of a Concord Kept', rank1: 10, rank2: 30 },
  'Aldrich Faithful': { token: 'Human Dregs', rank1: 10, rank2: 30 },
  'Watchdogs of Farron': { token: "Wolf's Blood Swordgrass", rank1: 10, rank2: 30 },
  'Rosaria\u2019s Fingers': { token: 'Pale Tongue', rank1: 10, rank2: 30 },
  'Mound-makers': { token: 'Vertebra Shackle', rank1: 10, rank2: 30 },
}

/**
 * Which missing spells are known covenant rewards.
 *
 * Deliberately short: only entries confirmed by the covenant reward lists. A
 * longer list would look more useful and be less trustworthy.
 */
export const COVENANT_SPELLS = {
  'Great Deep Soul': 'Aldrich Faithful',
  'Great Lightning Spear': 'Warrior of Sunlight',
  'Sunlight Spear': 'Warrior of Sunlight',
  'Sacred Oath': 'Warrior of Sunlight',
  'Darkmoon Blade': 'Blade of the Darkmoon',
}

/**
 * Best obtainable ring tier per family, derived from the reference table.
 *
 * A family whose only variants are +1/+2/+3 cannot be completed on this
 * playthrough — that is a real, provable NG+ requirement.
 */
export function ringTierFacts(rings, owned) {
  const families = new Map()
  for (const [idStr, name] of Object.entries(rings)) {
    const id = Number(idStr)
    if (id >= 536880000 && id < 536890000) continue // covenant entries
    const fam = name.replace(/\s*\+[123]\s*(DLC)?$/i, '').trim()
    if (!families.has(fam)) families.set(fam, [])
    families.get(fam).push({ id, tier: /\+\d|DLC/i.test(name) ? Number((name.match(/\+([123])/) || [0, 0])[1]) || 3 : 0 })
  }
  const out = new Map()
  for (const [fam, variants] of families) {
    const hasBase = variants.some((v) => v.tier === 0)
    const best = Math.max(...variants.map((v) => v.tier))
    out.set(fam, { hasBase, best })
  }
  return out
}

/**
 * Classify every missing collectible by how it can be obtained.
 *
 * @returns {{ now: object[], ngPlus: object[], covenant: object[], unknown: object[] }}
 */
export function classifyGaps({ axes, owned, bagNames, ringFacts }) {
  const now = []
  const ngPlus = []
  const covenant = []
  const unknown = []

  // --- rings ---------------------------------------------------------------
  for (const fam of axes.rings.missingFamilies) {
    const fact = ringFacts.get(fam)
    if (!fact) {
      unknown.push({ kind: 'ring', name: fam, why: '参考表里查不到这个戒指' })
      continue
    }
    if (!fact.hasBase) {
      ngPlus.push({
        kind: 'ring',
        name: fam,
        why: `本表只有 +1~+${fact.best} 变体，本世代拿不到基础款`,
      })
      continue
    }
    // A base ring that exists this playthrough, and that we hold no tier of.
    now.push({ kind: 'ring', name: fam, why: '基础款可在本世代获得' })
  }

  // --- spells --------------------------------------------------------------
  for (const [school, data] of Object.entries(axes.spells)) {
    for (const name of data.missing) {
      const cov = COVENANT_SPELLS[name]
      if (cov) {
        covenant.push({ kind: 'spell', school, name, why: `${cov} 教团奖励` })
      } else {
        now.push({ kind: 'spell', school, name, why: '非教团奖励，可在地图或 NPC 处获得' })
      }
    }
  }

  return { now, ngPlus, covenant, unknown }
}

/**
 * Covenant standing: how many more tokens each reward needs.
 *
 * Only reports covenants whose token the player already holds at least one of;
 * a covenant never touched says nothing useful.
 */
export function covenantStanding(tokens) {
  const rows = []
  for (const [covenant, spec] of Object.entries(COVENANT_REWARDS)) {
    const held = tokens[spec.token] ?? 0
    if (held <= 0) continue
    rows.push({
      covenant,
      token: spec.token,
      held,
      rank1: spec.rank1,
      rank2: spec.rank2,
      toRank1: Math.max(0, spec.rank1 - held),
      toRank2: Math.max(0, spec.rank2 - held),
    })
  }
  return rows.sort((a, b) => a.toRank1 - b.toRank1)
}

/**
 * Transposable boss souls: the boss is dead and its soul is still unspent.
 *
 * That combination is exactly "you can walk to the transposition kiln and get
 * one item right now", which is the most actionable thing the save can prove.
 */
export function transposableSouls(bagNames, killedBosses) {
  const killed = new Set(killedBosses)
  const out = []
  for (const [soul, boss] of Object.entries(SOUL_SOURCES)) {
    if (bagNames.has(soul) && killed.has(boss)) out.push({ soul, boss })
  }
  return out.sort((a, b) => a.soul.localeCompare(b.soul))
}

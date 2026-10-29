/**
 * Progress axes: what is left to collect, computed from the save itself.
 *
 * The bonfire count on its own says little — a cleared character and a
 * half-cleared one look similar. These axes turn "already have" into "still
 * missing", which is the only form the player can act on.
 *
 * Every axis must be *derivable from the save*. Anything requiring a wiki
 * checklist that the save cannot confirm is deliberately absent; see
 * docs/blueprint.md for why the knowledge base is deferred.
 */

/** Item-ID ranges. Derived from the reference table, not from the game files. */
const SORCERY = [1074900000, 1076000000]
const PYROMANCY = [1076000000, 1077000000]
const MIRACLE = [1077000000, 1078000000]
const COVENANT_RING = [536880000, 536890000]

function categoryOf(id) {
  if (id >= SORCERY[0] && id < SORCERY[1]) return 'sorcery'
  if (id >= PYROMANCY[0] && id < PYROMANCY[1]) return 'pyromancy'
  if (id >= MIRACLE[0] && id < MIRACLE[1]) return 'miracle'
  return 'item'
}

/** The +N tier of a ring, read from its display name rather than the id. */
function ringTier(name) {
  if (/\+3|DLC/i.test(name)) return 3
  if (/\+2/.test(name)) return 2
  if (/\+1/.test(name)) return 1
  return 0
}

/** A ring family is the name without its +N suffix, so tiers group together. */
function ringFamily(name) {
  return name
    .replace(/\s*\+[123]\s*(DLC)?$/i, '')
    .replace(/\s+DLC$/i, '')
    .trim()
}

/**
 * @param {object} args
 * @param {Record<string,string>} args.rings   id -> display name (reference table)
 * @param {Record<string,string>} args.goods   id -> display name (reference table)
 * @param {Set<number>} args.owned             item ids present in the save
 * @param {Array<{area:string,lit:number,total:number}>} args.byArea
 * @param {string[]} args.unlit                unlit bonfire labels
 */
export function buildAxes({ rings, goods, owned, byArea = [], unlit = [] }) {
  const ringIds = Object.keys(rings)
    .map(Number)
    .filter((id) => !(id >= COVENANT_RING[0] && id < COVENANT_RING[1]))

  // --- rings, counted per family so "+2" is not a separate collectible ------
  const families = new Map()
  for (const id of ringIds) {
    const fam = ringFamily(rings[id])
    if (!families.has(fam)) families.set(fam, [])
    families.get(fam).push({ id, name: rings[id], tier: ringTier(rings[id]) })
  }

  const ringHave = []
  const ringMissing = []
  const ringTierMissing = []
  for (const [fam, variants] of [...families.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const hit = variants.filter((v) => owned.has(v.id))
    if (!hit.length) {
      ringMissing.push(fam)
      continue
    }
    ringHave.push(fam)
    const best = Math.max(...hit.map((v) => v.tier))
    const top = Math.max(...variants.map((v) => v.tier))
    if (best < top) ringTierMissing.push({ ring: fam, have: best, best: top })
  }

  // --- spells, per school --------------------------------------------------
  const spells = { sorcery: [], pyromancy: [], miracle: [] }
  for (const [id, name] of Object.entries(goods)) {
    const cat = categoryOf(Number(id))
    if (cat !== 'item') spells[cat].push({ id: Number(id), name })
  }

  const spellAxes = {}
  for (const [school, list] of Object.entries(spells)) {
    list.sort((a, b) => a.name.localeCompare(b.name))
    const have = list.filter((s) => owned.has(s.id))
    spellAxes[school] = {
      have: have.length,
      total: list.length,
      missing: list.filter((s) => !owned.has(s.id)).map((s) => s.name),
    }
  }

  // --- covenants, read straight out of the ring table ----------------------
  const covenants = Object.entries(rings)
    .filter(([id]) => Number(id) >= COVENANT_RING[0] && Number(id) < COVENANT_RING[1])
    .map(([id, name]) => ({ name, owned: owned.has(Number(id)) }))
    .sort((a, b) => a.name.localeCompare(b.name))

  // --- bonfires, with an explicit note about the pseudo-marker -------------
  const bonfire = {
    areas: byArea,
    missing: byArea.filter((a) => a.lit < a.total).map((a) => ({ area: a.area, missing: a.total - a.lit, total: a.total })),
    unlit,
  }

  return {
    rings: {
      have: ringHave.length,
      total: families.size,
      missingFamilies: ringMissing.sort(),
      tierUpgrades: ringTierMissing.sort((a, b) => a.ring.localeCompare(b.ring)),
    },
    spells: spellAxes,
    covenants,
    bonfire,
  }
}

/**
 * One-line headline for each axis, ordered by how much it still needs.
 *
 * Deliberately reports ratio and count rather than a percentage: "38/116" is
 * actionable ("one boss drop"), "33%" is not.
 */
export function summarize(axes) {
  const rows = []
  rows.push({
    key: 'bonfire',
    label: '篝火',
    have: axes.bonfire.areas.reduce((s, a) => s + a.lit, 0),
    total: axes.bonfire.areas.reduce((s, a) => s + a.total, 0),
  })
  rows.push({ key: 'rings', label: '戒指', have: axes.rings.have, total: axes.rings.total })
  for (const [school, label] of [
    ['sorcery', '魔法'],
    ['pyromancy', '咒术'],
    ['miracle', '奇迹'],
  ]) {
    const a = axes.spells[school]
    rows.push({ key: school, label, have: a.have, total: a.total })
  }
  rows.push({
    key: 'covenants',
    label: '誓约',
    have: axes.covenants.filter((c) => c.owned).length,
    total: axes.covenants.length,
  })
  return rows
}

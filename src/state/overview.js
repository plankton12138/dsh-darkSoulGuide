/**
 * The one call the model makes to know where the player stands.
 *
 * Everything here is computed from the save plus the reference tables; nothing
 * is remembered between calls, so a stale answer cannot outlive the save file.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSection } from '../parsers/ds3/run.js'
import { buildAxes, summarize } from './progress.js'
import {
  classifyGaps,
  covenantStanding,
  ringTierFacts,
  transposableSouls,
} from './reachability.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REF = path.resolve(HERE, '..', '..', 'data', 'reference', 'ds3')

let tables = null

async function reference() {
  if (tables) return tables
  const { readFile } = await import('node:fs/promises')
  const [items, bonfires, routes] = await Promise.all([
    readFile(path.join(REF, 'items.json'), 'utf8').then(JSON.parse),
    readFile(path.join(REF, 'bonfires.json'), 'utf8').then(JSON.parse),
    readFile(path.join(REF, 'routes.json'), 'utf8').then(JSON.parse),
  ])
  tables = { items, bonfires, routes }
  return tables
}

/** Areas whose bonfires are not all lit, mapped to what is missing. */
function missingByArea(unlit) {
  const out = new Map()
  for (const label of unlit) {
    const area = label.split(' - ')[0]
    if (!out.has(area)) out.set(area, [])
    out.get(area).push(label)
  }
  return out
}

/**
 * Full standing for one character.
 *
 * `owned` is assembled from the inventory sections rather than trusting a
 * single "collection" field: DS3 stores no checklist, so presence in the bag
 * is the only evidence that an item was ever picked up.
 */
export async function overview(saveId) {
  const characters = await readSection(saveId, 'character')
  const [bonfires, bosses, progress, inventory, equipment] = await Promise.all([
    readSection(saveId, 'bonfires'),
    readSection(saveId, 'bosses'),
    readSection(saveId, 'progress'),
    readSection(saveId, 'inventory'),
    readSection(saveId, 'equipment'),
  ])

  const { items } = await reference()
  const owned = new Set((inventory.data.ownedIds ?? []).map(Number))

  const axes = buildAxes({
    rings: items.ring,
    goods: items.good,
    owned,
    byArea: bonfires.data.byArea ?? [],
    unlit: bonfires.data.unlit ?? [],
  })

  // Reachability: which gaps are actually actionable, and on what evidence.
  const ringFacts = ringTierFacts(items.ring, owned)
  const gaps = classifyGaps({ axes, owned, bagNames: new Set(), ringFacts })
  const tokens = inventory.data.covenantTokens ?? {}
  const souls = transposableSouls(new Set(inventory.data.bossSouls ?? []), bosses.data.killed ?? [])

  return {
    save_id: saveId,
    character: {
      name: characters.save_id,
      level: characters.data.level,
      souls: characters.data.souls,
      stats: characters.data.stats,
      playtimeHours: progress.data.playtimeHours,
      area: progress.data.area,
    },
    bosses: {
      killed: bosses.data.killedCount,
      total: bosses.data.killedCount + bosses.data.aliveCount,
      alive: bosses.data.alive,
    },
    axes,
    summary: summarize(axes),
    equipment: equipment.data,
    missingByArea: Object.fromEntries(missingByArea(bonfires.data.unlit ?? [])),
    reachability: {
      gaps,
      covenants: covenantStanding(tokens),
      souls,
    },
  }
}

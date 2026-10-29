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
import { endingStatus } from './endings.js'
import { achievementStatus } from './achievements.js'
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

/**
 * Bonfire labels that are not actually bonfires.
 *
 * `The First Flame` records the ending where the First Flame is lit, not a
 * bonfire. The game stores it in the bonfire table, so a cleared character
 * shows it as "missing" forever. It is separated here, at the source, so no
 * consumer has to remember to filter it — the client-side filter that used to
 * exist in two places is what let the map ask how to reach a bonfire that
 * does not exist.
 */
const NOT_A_BONFIRE = /First Flame/i

/** Areas whose bonfires are not all lit, mapped to what is missing. */
function missingByArea(unlit) {
  const out = new Map()
  for (const label of unlit) {
    if (NOT_A_BONFIRE.test(label)) continue
    const area = label.split(' - ')[0]
    if (!out.has(area)) out.set(area, [])
    out.get(area).push(label)
  }
  return out
}

/** The non-bonfire markers, kept separate so they can be reported honestly. */
function endingMarkers(unlit) {
  return (unlit || []).filter((l) => NOT_A_BONFIRE.test(l))
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
  const [bonfires, bosses, progress, inventory, equipment, endings] = await Promise.all([
    readSection(saveId, 'bonfires'),
    readSection(saveId, 'bosses'),
    readSection(saveId, 'progress'),
    readSection(saveId, 'inventory'),
    readSection(saveId, 'equipment'),
    readSection(saveId, 'endings'),
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

  const bagNames = new Set(
    (inventory.data.keyItems ?? []).concat(
      (inventory.data.bossSouls ?? []),
      Object.keys(tokens),
    ),
  )
  // The achievement view needs every display name, not just key items, so it
  // re-derives names from the reference tables against the owned id set.
  const allNames = new Set(bagNames)
  for (const [id, name] of Object.entries(items.good)) {
    if (owned.has(Number(id))) allNames.add(name)
  }
  for (const [id, name] of Object.entries(items.weapon)) {
    if (owned.has(Number(id))) allNames.add(name)
  }
  // Endings: the flags the parser exposes, read as a plain id -> 0/1 map.
  const endingFlags = {}
  for (const [fid, info] of Object.entries(endings?.data?.flags ?? {})) {
    endingFlags[fid] = info.value
  }
  const ending = await endingStatus({
    flags: endingFlags,
    killedBosses: bosses.data.killed ?? [],
  })

  const achievements = achievementStatus({
    owned,
    bagNames: allNames,
    rings: items.ring,
    axes,
    bosses: {
      killed: bosses.data.killedCount,
      total: bosses.data.killedCount + bosses.data.aliveCount,
      alive: bosses.data.alive,
    },
  })

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
    // Kept apart from the gaps: this is an ending marker, not something the
    // player forgot. Reported, never counted as a miss.
    endingMarkers: endingMarkers(bonfires.data.unlit ?? []),
    reachability: {
      gaps,
      covenants: covenantStanding(tokens),
      souls,
    },
    achievements,
    endings: ending,
  }
}

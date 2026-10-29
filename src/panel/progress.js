/**
 * Panel payload for the sidebar map and the composer status strip.
 *
 * Kept apart from the model-facing tools so the same numbers drive both halves
 * without the panel paying for tool schemas it never calls.
 */
import { listCharacters } from '../parsers/ds3/run.js'
import { loadRoutes } from '../state/route.js'
import { overview } from '../state/overview.js'

export async function buildProgress() {
  const chars = await listCharacters({ fresh: true })
  if (!chars.length) return { ok: false, reason: '存档里没有角色' }
  const saveId = chars[0].save_id

  const [o, routes] = await Promise.all([overview(saveId), Promise.resolve(loadRoutes())])

  const areas = {}
  for (const row of o.axes.bonfire.areas) {
    areas[row.area] = { lit: row.lit, total: row.total }
  }

  return {
    ok: true,
    character: {
      name: o.character.name,
      level: o.character.level,
      area: o.character.area,
      playtimeHours: o.character.playtimeHours,
      souls: o.character.souls,
    },
    bosses: { killed: o.bosses.killed, total: o.bosses.total, alive: o.bosses.alive },
    areas,
    // The strip and the map both read these, so one set of axes serves both.
    summary: o.summary,
    missingByArea: o.missingByArea,
    equipment: o.equipment,
    stats: o.character.stats,
    // Reachability: the panel's "next step" list is built from these rather
    // than recomputing rules in the client.
    reachability: o.reachability,
    achievements: o.achievements,
    edges: routes.edges.map((e) => ({ from: e.from, to: e.to })),
    updatedAt: new Date().toISOString(),
  }
}

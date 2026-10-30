/**
 * Panel payload for the sidebar map and the composer status strip.
 *
 * Kept apart from the model-facing tools so the same numbers drive both halves
 * without the panel paying for tool schemas it never calls.
 *
 * This function never rejects. Anyone installing the plugin from the public
 * repository starts with no save file, and a thrown Ds3Error loses its `hint` on
 * the way to the UI — the panel would show a bare "cannot read the save" with no
 * indication of where the file is expected. Every failure is therefore returned
 * as a structured reason plus the hint that explains what to do next.
 */
import { Ds3Error, listCharacters } from '../parsers/ds3/run.js'
import { loadRoutes } from '../state/route.js'
import { overview } from '../state/overview.js'

/** Turn a parser failure into something the panel can render and act on. */
function failure(err) {
  if (err instanceof Ds3Error) {
    return { ok: false, reason: err.message, hint: err.hint ?? null, code: err.code }
  }
  return { ok: false, reason: String(err?.message ?? err), hint: null, code: 'unknown' }
}

export async function buildProgress() {
  let chars
  try {
    chars = await listCharacters({ fresh: true })
  } catch (err) {
    return failure(err)
  }
  if (!chars.length) {
    return {
      ok: false,
      reason: '存档里没有角色',
      hint: '在游戏里创建一个角色并保存一次，再回到这里。',
      code: 'no_character',
    }
  }
  const saveId = chars[0].save_id

  let o
  let routes
  try {
    ;[o, routes] = await Promise.all([overview(saveId), Promise.resolve(loadRoutes())])
  } catch (err) {
    return failure(err)
  }

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
    endingMarkers: o.endingMarkers ?? [],
    equipment: o.equipment,
    stats: o.character.stats,
    // Reachability: the panel's "next step" list is built from these rather
    // than recomputing rules in the client.
    reachability: o.reachability,
    achievements: o.achievements,
    endings: o.endings,
    steam: o.steam,
    edges: routes.edges.map((e) => ({ from: e.from, to: e.to })),
    updatedAt: new Date().toISOString(),
  }
}

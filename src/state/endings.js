/**
 * Endings: which ones the player already reached, and which are still open.
 *
 * Two questions, two sources, and they must not be confused:
 *
 *   "did you already reach it"  -> Steam achievements (authoritative, and they
 *                                 survive across playthroughs)
 *   "can you reach it now"      -> the save (is the story at that point yet)
 *
 * An earlier version answered the first question from a save flag named after
 * the First Flame. That flag does not mean what its name suggests, and the
 * module told a player who had already finished an ending that they had not.
 * The save keeps no record of endings at all.
 *
 * A naming trap worth knowing: 传火终结 is The End of Fire — the Fire Keeper
 * ending where the flame is put out. Its Chinese name reads like "completing
 * the linking of the fire", which is close to the opposite. 初始之火的继承者
 * (To Link the First Flame) is the default one.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FILE = path.resolve(HERE, '..', '..', 'data', 'reference', 'ds3', 'endings.json')

let cached = null

async function load() {
  if (cached) return cached
  cached = JSON.parse(await readFile(FILE, 'utf8'))
  return cached
}

/** Boss whose defeat opens the final bonfire — where endings branch. */
const FINAL_BOSS = '薪王们的化身'

/**
 * Build the ending status.
 *
 * @param {object} args
 * @param {Array<{api:string,name:string,unlocked:boolean,unlockedAt:number|null}>} args.achievements
 * @param {string[]} args.killedBosses
 */
export async function endingStatus({ achievements = [], killedBosses = [] }) {
  const doc = await load()
  const killed = new Set(killedBosses ?? [])
  const byApi = Object.fromEntries((achievements ?? []).map((a) => [a.api, a]))
  const atFinalBonfire = killed.has(FINAL_BOSS)

  const endings = doc.endings.map((e) => {
    const ach = e.achievement ? byApi[e.achievement] : null
    const reached = ach ? ach.unlocked === true : false

    let state
    let evidence

    if (reached) {
      state = 'done'
      const when = ach?.unlockedAt
        ? new Date(ach.unlockedAt * 1000).toISOString().slice(0, 10)
        : null
      evidence = `成就「${e.name}」已解锁${when ? `（${when}）` : ''} —— 这个结局你拿到过。`
    } else if (atFinalBonfire) {
      state = 'available'
      evidence = '已击败薪王们的化身，可以回最终篝火触发这个结局（每个周目只能选一个）。'
    } else {
      state = 'locked'
      evidence = '尚未击败薪王们的化身，还到不了最终篝火。'
    }

    return {
      id: e.id,
      achievement: e.achievement ?? null,
      name: e.name,
      alias: e.alias,
      order: e.order,
      condition: e.condition,
      difficulty: e.difficulty,
      prerequisites: e.prerequisites ?? [],
      stage: e.stage ?? null,
      state,
      evidence,
      notes: e.notes ?? null,
    }
  })

  const done = endings.filter((e) => e.state === 'done')
  return {
    endings,
    reached: done.length,
    total: doc.endings.length,
    reachedNames: done.map((e) => e.name),
    stillOpen: endings.filter((e) => e.state === 'available').map((e) => e.name),
    precedence: doc._precedence ?? [],
    namingWarning: doc._naming_warning ?? null,
    source: doc._source ?? null,
  }
}

/**
 * Endings: what the save proves, and what it cannot.
 *
 * The temptation with endings is to write "you got 2 of 4". The save cannot
 * support that: it keeps no list of which endings a character has seen. It
 * holds one flag for the First Flame being lit and one for the Lords of Cinder
 * being beaten, and the other two endings leave no readable trace at all.
 *
 * So this module reports per ending, and states for each whether it is
 * confirmed, inferred, or unverifiable. A number that cannot be derived is
 * worse than an admission.
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

/** Boss flags that stand in for "the story reached this point". */
const STORY_FLAGS = {
  lordsOfCinder: 14100800,
  gael: 15110800,
}

/**
 * Build the ending status for one character.
 *
 * @param {object} args
 * @param {Record<string, number>} args.flags  flag id -> 0/1
 * @param {string[]} args.killedBosses
 */
export async function endingStatus({ flags = {}, killedBosses = [] }) {
  const doc = await load()
  const killed = new Set(killedBosses)

  const flameLit = flags[14100002] === 1
  const lordsDead = flags[STORY_FLAGS.lordsOfCinder] === 1
  const gaelDead = killed.has('奴仆骑士盖尔') || flags[STORY_FLAGS.gael] === 1

  const endings = doc.endings.map((e) => {
    let state = 'unknown'
    let evidence = ''

    switch (e.id) {
      case 'link-the-flame':
        if (flameLit) {
          state = 'done'
          evidence = '旗标 14100002（初始之火）已置位 —— 这个结局已触发。'
        } else if (lordsDead) {
          state = 'available'
          evidence = '已击败薪王化身，但初始之火未点燃 —— 说明还没选这个结局。'
        } else {
          state = 'locked'
          evidence = '尚未击败薪王化身。'
        }
        break
      case 'lord-of-cinder':
        if (lordsDead && !flameLit) {
          state = 'done'
          evidence = '化身已死且初始之火未点燃 —— 与「传火成王」一致（它不需要任何额外操作）。'
        } else if (lordsDead) {
          state = 'ambiguous'
          evidence = '化身已死且初始之火已点燃 —— 与「传火终结」一致，不是传火成王。'
        } else {
          state = 'locked'
          evidence = '尚未击败薪王化身。'
        }
        break
      case 'age-of-darkness':
        if (gaelDead) {
          state = 'possible'
          evidence = '已击败奴仆骑士盖尔（DLC2 前置达成），但该结局本身在存档里没有可读标记。'
        } else {
          state = 'locked'
          evidence = '尚未击败奴仆骑士盖尔。'
        }
        break
      case 'usurpation':
        if (lordsDead) {
          state = 'possible'
          evidence = '前置与传火终结相同，但「中途攻击防火女」不留可读标记，无法与传火终结区分。'
        } else {
          state = 'locked'
          evidence = '尚未击败薪王化身。'
        }
        break
      default:
        break
    }

    return {
      id: e.id,
      name: e.name,
      alias: e.alias,
      order: e.order,
      condition: e.condition,
      difficulty: e.difficulty,
      prerequisites: e.prerequisites ?? [],
      verifyLevel: e.verify.level,
      verifyNote: e.verify.how,
      state,
      evidence,
      notes: e.notes ?? null,
    }
  })

  return {
    endings,
    // Deliberately not a percentage: three of the four endings leave no
    // readable mark, so a count here would be a guess.
    confirmed: endings.filter((e) => e.state === 'done').length,
    confirmable: endings.filter((e) => e.verifyLevel !== 'inferred').length,
    total: endings.length,
    precedence: doc._precedence ?? [],
    cycleNote: doc._cycle_note ?? null,
    source: doc._source ?? null,
  }
}

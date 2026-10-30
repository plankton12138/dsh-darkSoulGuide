/**
 * Place guides: "where do I get X, and how do I get there".
 *
 * The save can answer "do I have it" but never "where is it". Item locations,
 * NPC dialogue progress, hidden paths and gesture prerequisites are all absent
 * from the save — see the probes recorded in achievements.js for what was
 * checked and found missing. This module supplies only that missing half, from
 * `data/reference/ds3/places.json`, and is careful to say which half is which.
 *
 * The output is deliberately three-part, because a bare "it's in Irithyll"
 * answers nothing: the player needs to know whether it is already lost, how to
 * walk there, and what will bite them on the way.
 *
 *   ① status    what the save proves, or an explicit "cannot tell"
 *   ② route     the bonfire to start from and the steps after it
 *   ③ caveats   prerequisites, one-way doors, quest lines that can be locked out
 *
 * Two honesty rules are enforced here rather than left to the caller:
 *   - A prerequisite the save cannot verify is reported as `unknown`, never as
 *     satisfied. Guessing "you probably have it" is how a guide sends someone
 *     on a wasted trip.
 *   - `confidence: medium` entries carry a warning string, so the model cannot
 *     present a single-source detail as settled fact.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REF = path.resolve(HERE, '..', '..', 'data', 'reference', 'ds3')

let cached = null

async function load() {
  if (cached) return cached
  const [places, sources] = await Promise.all([
    readFile(path.join(REF, 'places.json'), 'utf8').then(JSON.parse),
    readFile(path.join(REF, 'sources.json'), 'utf8').then(JSON.parse),
  ])
  cached = { places, sources }
  return cached
}

/** CJK-aware term splitting, matching the approach used by the citation tool. */
function terms(query) {
  const raw = String(query ?? '')
    .toLowerCase()
    .split(/[\s,，、。？?!/]+/)
    .filter(Boolean)
  const out = new Set(raw)
  for (const t of raw) {
    if (!/[\u4e00-\u9fff]/.test(t)) continue
    for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2))
  }
  return [...out]
}

function scorePlace(place, list) {
  const fields = [
    place.name?.zh,
    place.name?.en,
    ...(place.aliases ?? []),
    place.where?.area,
    place.where?.bonfireName,
    place.achievement?.api,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  let n = 0
  for (const t of list) {
    if (!t) continue
    if (fields.includes(t)) n += 1
  }
  return n
}

/**
 * Resolve what the save says about one place.
 *
 * @returns {{state:string, evidence:string, verified:boolean}}
 *   state: 'owned' | 'missing' | 'unknown'
 *   verified: false whenever the save literally cannot see it.
 */
function checkSave(place, ctx) {
  const check = place.saveCheck
  if (!check) {
    return {
      state: 'unknown',
      verified: false,
      evidence: '这条没有配置存档判定，插件无法确认你的状态。',
    }
  }

  if (check.kind === 'covenant') {
    const covs = ctx.covenantNames ?? new Set()
    const has = [...covs].some((n) => String(n).toLowerCase() === String(check.id).toLowerCase())
    return {
      state: has ? 'owned' : 'missing',
      verified: true,
      evidence: has
        ? `存档显示你已加入「${place.name.zh}」，这条可以跳过。`
        : `存档显示你还没加入「${place.name.zh}」——按下面的步骤去签。`,
    }
  }

  if (check.kind === 'item') {
    const owned = ctx.ownedIds ?? new Set()
    const has = owned.has(Number(check.id))
    return {
      state: has ? 'owned' : 'missing',
      verified: true,
      evidence: has
        ? `背包里已有「${place.name.zh}」。`
        : `背包里还没有「${place.name.zh}」。`,
    }
  }

  if (check.kind === 'boss') {
    const killed = ctx.killedBosses ?? new Set()
    const has = [...killed].some((n) => String(n).includes(check.name ?? '\u0000'))
    return {
      state: has ? 'owned' : 'missing',
      verified: true,
      evidence: has
        ? `存档显示「${check.name}」已击败。`
        : `存档显示「${check.name}」还没击败。`,
    }
  }

  return {
    state: 'unknown',
    verified: false,
    evidence: '存档里没有这条记录，无法确认。',
  }
}

/** Prerequisites, with the ones the save cannot see marked as unknown. */
function checkRequires(place, ctx) {
  return (place.requires ?? []).map((req) => {
    if (req.saveVerifiable === false) {
      return {
        kind: req.kind,
        name: req.name,
        en: req.en ?? null,
        from: req.from ?? null,
        why: req.why ?? null,
        ifMissing: req.ifMissing ?? null,
        state: 'unknown',
        evidence: `存档不记录${req.kind === 'gesture' ? '肢体动作' : '这类前置'}，所以这一个只能你自己确认。`,
      }
    }
    return {
      ...req,
      state: 'unknown',
      evidence: '存档无法确认这个前置。',
    }
  })
}

/** Turn source ids into resolved links, dropping any that do not exist. */
function resolveSources(ids, sourcesDoc) {
  const byId = new Map((sourcesDoc.sources ?? []).map((s) => [s.id, s]))
  return (ids ?? [])
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((s) => ({ id: s.id, title: s.title, url: s.url, caveat: s.caveat ?? null }))
}

/**
 * Build the three-part guide for one place, ready to render or to speak.
 */
function buildGuide(place, ctx, sourcesDoc) {
  const status = checkSave(place, ctx)
  const requires = checkRequires(place, ctx)
  const sources = resolveSources(place.sources, sourcesDoc)

  const warnings = []
  if (place.confidence === 'medium') {
    warnings.push('这条信息来自单一来源，细节可能有偏差，按上面的出处核对一下。')
  }
  if (place.missable) {
    warnings.push(`本周目可能锁死：${place.missableReason ?? '错过就要等下一周目。'}`)
  }
  for (const g of place.gotchas ?? []) warnings.push(g)
  for (const r of requires) {
    if (r.state !== 'owned' && r.ifMissing) warnings.push(`缺少「${r.name}」：${r.ifMissing}`)
  }
  if (!sources.length) {
    warnings.push('这条没有可核对的出处，可信度较低。')
  }

  return {
    id: place.id,
    kind: place.kind,
    name: place.name,
    aliases: place.aliases ?? [],
    // ① status
    status,
    // ② route
    where: place.where ?? null,
    steps: place.steps ?? [],
    // ③ caveats
    requires,
    warnings,
    achievement: place.achievement ?? null,
    missable: place.missable === true,
    confidence: place.confidence ?? 'medium',
    sources,
  }
}

/**
 * Look up place guides by free-text query.
 *
 * @param {string} query
 * @param {object} ctx  what the save knows: ownedIds, covenantNames, killedBosses
 */
export async function findPlaces(query, ctx = {}) {
  const { places, sources } = await load()
  const list = terms(query)
  const scored = (places.places ?? [])
    .map((p) => ({ place: p, score: scorePlace(p, list) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)

  if (!scored.length) {
    return {
      query,
      matches: [],
      hint: '地点库里没有这一条。请用 ds3_sources 给出可核对的攻略链接，不要凭记忆描述位置。',
      total: (places.places ?? []).length,
    }
  }

  return {
    query,
    matches: scored.map((x) => buildGuide(x.place, ctx, sources)),
    total: (places.places ?? []).length,
  }
}

/** Every guide, for the panel. */
export async function allPlaces(ctx = {}) {
  const { places, sources } = await load()
  return {
    matches: (places.places ?? []).map((p) => buildGuide(p, ctx, sources)),
    total: (places.places ?? []).length,
  }
}

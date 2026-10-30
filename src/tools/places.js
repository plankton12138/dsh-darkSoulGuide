/**
 * `ds3_place`: "where do I get X, and how do I walk there".
 *
 * This is the tool that turns a location question into the three-part answer
 * described in state/places.js. It exists as its own tool rather than a field
 * inside `ds3_overview` because it is asked per-item ("where is the Darkmoon
 * covenant", "where is Havel's Ring") and the overview is already large.
 *
 * The render deliberately leads with status, then route, then caveats: a player
 * asking "where" needs to know first whether the trip is even worth making.
 */
import { findPlaces } from '../state/places.js'
import { overview } from '../state/overview.js'
import { Ds3Error, listCharacters } from '../parsers/ds3/run.js'

async function resolveSaveId(arg) {
  if (arg) return arg
  const chars = await listCharacters()
  if (!chars.length) throw new Ds3Error('no_save', '存档里没有角色')
  return chars[0].save_id
}

/**
 * What the save knows, in the shape state/places.js expects.
 *
 * Read fresh from the save on every call rather than cached: a place's status
 * flips the moment the player signs a covenant, and a stale "you don't have it"
 * is exactly the kind of wrong answer this module exists to avoid.
 */
async function saveContext(saveId) {
  const o = await overview(saveId)
  const cov = new Set(
    (o.axes?.covenants ?? []).filter((c) => c.owned).map((c) => c.name),
  )
  const ownedIds = new Set()
  // Ring/goods ids are reconstructed from the axes for the checks that need
  // them; covenant membership is the only check in the library so far.
  return {
    covenantNames: cov,
    ownedIds,
    killedBosses: new Set(o.bosses?.alive ? [] : []),
    character: o.character,
  }
}

function renderGuide(g) {
  const lines = []

  const head = g.name?.zh ?? g.id
  const en = g.name?.en ? `（${g.name.en}）` : ''
  lines.push(`【${head}】${en}`)

  // ① status — what the save proves, or that it cannot tell.
  const mark = g.status.state === 'owned' ? '✔' : g.status.state === 'missing' ? '○' : '?'
  lines.push(`${mark} ${g.status.evidence}`)

  // ② route
  if (g.where?.area || g.where?.bonfireName) {
    const area = g.where.area ? `区域：${g.where.area}` : null
    const bf = g.where.bonfireName ? `从篝火「${g.where.bonfireName}」出发` : null
    lines.push('')
    lines.push([area, bf].filter(Boolean).join('；'))
    if (g.where.landmark) lines.push(`位置：${g.where.landmark}`)
  }
  if (g.steps?.length) {
    lines.push('')
    g.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`))
  }

  // ③ caveats
  const reqs = g.requires ?? []
  if (reqs.length) {
    lines.push('')
    lines.push('前置：')
    for (const r of reqs) {
      const tag = r.state === 'owned' ? '✔' : r.state === 'unknown' ? '?' : '✘'
      lines.push(`  ${tag} ${r.name}${r.from ? `（来自${r.from}）` : ''}`)
      if (r.why) lines.push(`     ${r.why}`)
      if (r.state === 'unknown' && r.evidence) lines.push(`     ${r.evidence}`)
    }
  }
  if (g.warnings?.length) {
    lines.push('')
    lines.push('注意：')
    for (const w of g.warnings) lines.push(`  ⚠ ${w}`)
  }

  if (g.achievement) {
    lines.push('')
    lines.push(`成就 ${g.achievement.api}：${g.achievement.condition}`)
    if (g.achievement.note) lines.push(`  ${g.achievement.note}`)
  }

  if (g.sources?.length) {
    lines.push('')
    lines.push('出处（正文未收录，请自行核对）：')
    for (const s of g.sources) lines.push(`  - ${s.title}：${s.url}`)
  }

  if (g.confidence && g.confidence !== 'high') {
    lines.push('')
    lines.push(`可信度：${g.confidence}（单一来源，细节可能有偏差）`)
  }

  return lines.join('\n')
}

export function registerPlacesTool(ctx) {
  ctx.effect(() =>
    ctx.tools.register({
      name: 'ds3_place',
      description:
        'Look up where an item, covenant, NPC or boss is, and how to walk there from a bonfire. Returns a three-part guide: what the save proves about your status, the route (starting bonfire plus steps), and the caveats (prerequisites, one-way doors, quest lines that can be locked out). Use this instead of describing a location from memory. If the place is not in the library, use ds3_sources for a link rather than inventing directions.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: {
            type: 'string',
            description:
              'What to locate, e.g. "暗月之剑", "Havel\'s Ring", "无主墓地", "希里丝". Chinese or English both work.',
          },
          save_id: {
            type: 'string',
            description: 'Character to read. Omit to use the first character found.',
          },
        },
        required: ['query'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            query: { type: 'string' },
            total: { type: 'number' },
            hint: { type: 'string' },
            matches: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  id: { type: 'string' },
                  kind: { type: 'string' },
                  name: {
                    type: 'object',
                    additionalProperties: true,
                    properties: { zh: { type: 'string' }, en: { type: 'string' } },
                  },
                  status: {
                    type: 'object',
                    additionalProperties: true,
                    properties: {
                      state: { type: 'string' },
                      verified: { type: 'boolean' },
                      evidence: { type: 'string' },
                    },
                  },
                  where: { type: 'object', additionalProperties: true },
                  steps: { type: 'array', items: { type: 'string' } },
                  requires: { type: 'array', items: { type: 'object', additionalProperties: true } },
                  warnings: { type: 'array', items: { type: 'string' } },
                  achievement: { type: 'object', additionalProperties: true },
                  confidence: { type: 'string' },
                  sources: { type: 'array', items: { type: 'object', additionalProperties: true } },
                },
              },
            },
          },
        },
        render: (_args, v) => {
          if (!v.matches?.length) {
            return [
              {
                type: 'text',
                text: `地点库里没有匹配的条目。\n${v.hint ?? '请用 ds3_sources 给出可核对的链接，不要凭记忆描述位置。'}`,
              },
            ]
          }
          const parts = v.matches.slice(0, 3).map(renderGuide)
          return [{ type: 'text', text: parts.join('\n\n--------------------\n\n') }]
        },
      },
      async execute(args) {
        const saveId = await resolveSaveId(args?.save_id)
        const ctx = await saveContext(saveId)
        return findPlaces(args?.query, ctx)
      },
    }),
  )
}

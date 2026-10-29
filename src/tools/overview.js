/**
 * The guide tool: one call that answers "where am I and what is left".
 *
 * Separate from ds3_get_section on purpose — that tool is the raw reader, this
 * one is the opinionated summary the guide actually needs at the start of a
 * conversation, so the model does not spend four calls assembling it.
 */
import { overview } from '../state/overview.js'
import { Ds3Error, listCharacters } from '../parsers/ds3/run.js'

async function resolveSaveId(arg) {
  if (arg) return arg
  const chars = await listCharacters()
  if (!chars.length) throw new Ds3Error('no_save', '存档里没有角色')
  return chars[0].save_id
}

const AXIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    key: { type: 'string' },
    label: { type: 'string' },
    have: { type: 'integer' },
    total: { type: 'integer' },
  },
}

const OVERVIEW_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    save_id: { type: 'string' },
    character: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        level: { type: 'integer' },
        souls: { type: 'integer' },
        playtimeHours: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        area: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        stats: { type: 'object', additionalProperties: true },
      },
    },
    bosses: {
      type: 'object',
      additionalProperties: false,
      properties: {
        killed: { type: 'integer' },
        total: { type: 'integer' },
        alive: { type: 'array', items: { type: 'string' } },
      },
    },
    summary: { type: 'array', items: AXIS_SCHEMA },
    rings: {
      type: 'object',
      additionalProperties: false,
      properties: {
        have: { type: 'integer' },
        total: { type: 'integer' },
        missing: { type: 'array', items: { type: 'string' } },
        tierUpgrades: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ring: { type: 'string' },
              have: { type: 'integer' },
              best: { type: 'integer' },
            },
          },
        },
      },
    },
    spells: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sorcery: { type: 'object', additionalProperties: true },
        pyromancy: { type: 'object', additionalProperties: true },
        miracle: { type: 'object', additionalProperties: true },
      },
    },
    covenants: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string' }, owned: { type: 'boolean' } },
      },
    },
    equipment: { type: 'object', additionalProperties: true },
    missingByArea: { type: 'object', additionalProperties: true },
    readyNow: {
      type: 'object',
      additionalProperties: false,
      properties: {
        souls: {
          type: 'array',
          description: 'Boss souls still unspent: the boss is dead, so one item is available immediately.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { soul: { type: 'string' }, boss: { type: 'string' } },
          },
        },
        gaps: {
          type: 'array',
          description: 'Missing collectibles obtainable on this playthrough, not gated by covenant or NG+.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string' },
              name: { type: 'string' },
              school: { type: 'string' },
              why: { type: 'string' },
            },
          },
        },
        covenantGaps: {
          type: 'array',
          description: 'Missing items locked behind covenant ranks.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string' },
              name: { type: 'string' },
              school: { type: 'string' },
              why: { type: 'string' },
            },
          },
        },
        ngPlusOnly: {
          type: 'array',
          description: 'Missing items that cannot be completed on this playthrough.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string' },
              name: { type: 'string' },
              why: { type: 'string' },
            },
          },
        },
      },
    },
    covenantStanding: {
      type: 'array',
      description: 'Turn-in progress for covenants the player has already started.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          covenant: { type: 'string' },
          token: { type: 'string' },
          held: { type: 'integer' },
          rank1: { type: 'integer' },
          toRank1: { type: 'integer' },
          toRank2: { type: 'integer' },
        },
      },
    },
  },
}

function renderOverview(_args, v) {
  const c = v.character
  const lines = []
  lines.push(`${c.name} Lv${c.level}｜${c.area || '位置未知'}｜${c.playtimeHours ?? '?'} 小时｜持有 ${c.souls} 魂`)
  lines.push(`Boss ${v.bosses.killed}/${v.bosses.total}${v.bosses.alive.length ? `（未打：${v.bosses.alive.join('、')}）` : ''}`)
  lines.push('收集进度：')
  for (const row of v.summary) {
    const left = row.total - row.have
    lines.push(`  ${row.label} ${row.have}/${row.total}${left ? `（还差 ${left}）` : '（已满）'}`)
  }
  if (v.rings.missing.length) {
    const head = v.rings.missing.slice(0, 12)
    lines.push(`戒指缺口：${head.join('、')}${v.rings.missing.length > 12 ? ` 等 ${v.rings.missing.length} 个` : ''}`)
  }
  if (v.rings.tierUpgrades.length) {
    lines.push(`可升级戒指：${v.rings.tierUpgrades.map((r) => `${r.ring}（${r.have ? `+${r.have}` : '基础'}→+${r.best}）`).join('、')}`)
  }
  const cov = v.covenants.filter((x) => x.owned).map((x) => x.name)
  lines.push(`已加入誓约：${cov.join('、') || '无'}`)
  const areas = Object.entries(v.missingByArea || {})
  if (areas.length) {
    lines.push('篝火缺口：')
    for (const [area, list] of areas) lines.push(`  ${area}：${list.map((l) => l.split(' - ').slice(1).join(' - ')).join('、')}`)
  }

  // Reachability, ordered by how soon it can be acted on. This is the section
  // that turns counts into a decision, so it goes last and gets a heading.
  const ready = v.readyNow || {}
  if ((ready.souls || []).length) {
    lines.push(`现在就能换：${ready.souls.length} 个 Boss 灵魂未使用`)
    for (const s of ready.souls.slice(0, 12)) lines.push(`  ${s.soul} ← ${s.boss}`)
    if (ready.souls.length > 12) lines.push(`  ……另有 ${ready.souls.length - 12} 个`)
  }
  if ((ready.covenantGaps || []).length) {
    lines.push(`教团卡住：${ready.covenantGaps.map((g) => `${g.name}（${g.why}）`).join('、')}`)
  }
  if ((v.covenantStanding || []).length) {
    lines.push('教团进度：')
    for (const c of v.covenantStanding) {
      lines.push(`  ${c.covenant}：${c.token} ${c.held}/${c.rank1}（还差 ${c.toRank1} 到一级）`)
    }
  }
  if ((ready.ngPlusOnly || []).length) {
    lines.push(`本世代拿不到：${ready.ngPlusOnly.map((g) => g.name).join('、')}`)
  }
  if ((ready.gaps || []).length) {
    lines.push(`本轮可补：${ready.gaps.length} 项（非教团、非 NG+）`)
  }

  return [{ type: 'text', text: lines.join('\n') }]
}

export function registerOverviewTool(ctx) {
  ctx.effect(() =>
    ctx.tools.register({
      name: 'ds3_overview',
      description:
        "One call that summarises where the player is: level, area, boss count, and what is still uncollected across bonfires, rings, spells and covenants. Use it first when the player asks what to do next, what they are missing, or anything that depends on their current standing. Missing rings and spells are listed by name because the answer is actionable; bonfires are grouped by area.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          save_id: { type: 'string', description: 'Character to inspect. Omit when the save holds one character.' },
        },
      },
      output: { schema: OVERVIEW_OUTPUT, render: renderOverview },
      async execute(args) {
        const saveId = await resolveSaveId(args?.save_id)
        const o = await overview(saveId)
        return {
          save_id: o.save_id,
          character: o.character,
          bosses: o.bosses,
          summary: o.summary,
          rings: {
            have: o.axes.rings.have,
            total: o.axes.rings.total,
            missing: o.axes.rings.missingFamilies,
            tierUpgrades: o.axes.rings.tierUpgrades,
          },
          spells: o.axes.spells,
          covenants: o.axes.covenants,
          equipment: o.equipment,
          missingByArea: o.missingByArea,
          readyNow: {
            souls: o.reachability.souls,
            gaps: o.reachability.gaps.now.slice(0, 40),
            covenantGaps: o.reachability.gaps.covenant,
            ngPlusOnly: o.reachability.gaps.ngPlus,
          },
          covenantStanding: o.reachability.covenants,
        }
      },
    }),
  )
}

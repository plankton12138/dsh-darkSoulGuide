/** Model-facing tools for the DS3 guide assistant.
 *
 * Definitions are plain objects with standard JSON Schema, so this bundle has
 * no runtime dependencies: nothing to resolve at activation time.
 */
import { Ds3Error, diffSaves, listCharacters, readSection } from '../parsers/ds3/run.js'
import { planRoute } from '../state/route.js'

const FLAG_CHANGE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    flag: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    bit: { type: 'string' },
    label: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  },
}

/** Surface a parser failure as a message the model can act on. */
function fail(err) {
  if (err instanceof Ds3Error) {
    throw new Error(err.hint ? `${err.message} — ${err.hint}` : err.message)
  }
  throw err
}

const CHARACTER_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    save_id: { type: 'string', description: 'Pass this to ds3_get_section.' },
    name: { type: 'string' },
    slot: { type: 'integer' },
    level: { type: 'integer' },
    summary: { type: 'string', description: 'One-line human summary.' },
    sections: {
      type: 'array',
      items: { type: 'string' },
      description: 'Data sections available for this character.',
    },
  },
}

const LIST_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    characters: { type: 'array', items: CHARACTER_ITEM },
    save_path: { type: 'string' },
  },
}

const SECTION_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    save_id: { type: 'string' },
    section: { type: 'string' },
    description: { type: 'string' },
    data: { type: 'object', additionalProperties: true },
  },
}

function renderList(_args, value) {
  const chars = value.characters || []
  if (chars.length === 0) return [{ type: 'text', text: '存档里没有任何角色。' }]
  const lines = chars.map(
    (c) => `${c.name} — Lv${c.level}（槽 ${c.slot}）｜可读切片：${(c.sections || []).join(', ') || '无'}`,
  )
  if (value.save_path) lines.push(`存档：${value.save_path}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderSection(_args, value) {
  const d = value.data || {}
  if (value.section === 'character' && d.stats) {
    const s = d.stats
    return [
      {
        type: 'text',
        text: [
          `${value.save_id} — Lv${d.level}，持有 ${d.souls} 魂`,
          `生命力 ${s.VIG}｜集中力 ${s.ATN}｜持久力 ${s.END}｜体力 ${s.VIT}`,
          `力气 ${s.STR}｜敏捷 ${s.DEX}｜智力 ${s.INT}｜信仰 ${s.FTH}｜运气 ${s.LCK}`,
        ].join('\n'),
      },
    ]
  }
  if (value.section === 'bosses' && Array.isArray(d.killed)) {
    return [
      {
        type: 'text',
        text: [
          `已击败 ${d.killedCount} 个：${d.killed.join('、') || '无'}`,
          `未击败 ${d.aliveCount} 个：${d.alive.join('、') || '无'}`,
        ].join('\n'),
      },
    ]
  }
  if (value.section === 'progress') {
    return [
      {
        type: 'text',
        text: `游戏时长 ${d.playtimeHours} 小时｜最后休息：${d.area || '未知'}（篝火 ID ${d.lastBonfireId}）`,
      },
    ]
  }
  if (value.section === 'inventory') {
    const c = d.counts || {}
    const lines = [
      `背包：武器 ${c.weapon || 0}｜防具 ${c.armor || 0}｜戒指 ${c.ring || 0}｜消耗品与魔法 ${c.good || 0}`,
      `关键道具 ${(d.keyItems || []).length} 件：${(d.keyItems || []).join('、') || '无'}`,
      `堆叠最多：${(d.topStacks || []).map((s) => `${s.name}×${s.count}`).join('、') || '无'}`,
    ]
    if (d.unnamedCount) lines.push(`另有 ${d.unnamedCount} 件物品暂无名称映射`)
    return [{ type: 'text', text: lines.join('\n') }]
  }
  if (value.section === 'equipment') {
    const label = {
      left_hand: '左手',
      right_hand: '右手',
      head: '头',
      chest: '身',
      hands: '手',
      legs: '腿',
      ring_1: '戒指1',
      ring_2: '戒指2',
      ring_3: '戒指3',
      ring_4: '戒指4',
    }
    const lines = Object.entries(d).map(([slot, name]) => `${label[slot] || slot}：${name || '（空）'}`)
    return [{ type: 'text', text: lines.join('\n') }]
  }
  if (value.section === 'bonfires' && Array.isArray(d.byArea)) {
    const areaLines = d.byArea.map((a) => `${a.area} ${a.lit}/${a.total}`)
    return [
      {
        type: 'text',
        text: [
          `已点亮 ${d.litCount}/${d.total} 个篝火`,
          `按区域：${areaLines.join('，')}`,
          `未点亮：${(d.unlit || []).join('；') || '无'}`,
        ].join('\n'),
      },
    ]
  }
  return [{ type: 'text', text: `${value.save_id} / ${value.section}：${JSON.stringify(d)}` }]
}

export function registerTools(ctx) {
  ctx.effect(() =>
    ctx.tools.register({
      name: 'ds3_list_saves',
      description:
        'List every Dark Souls III character in the local save file: name, level, souls held, and which data sections are readable. Call this first before answering anything about the player’s progress.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fresh: {
            type: 'boolean',
            description:
              'Re-read the save instead of using the 5-second cache. Use it after the player says they just saved.',
          },
        },
      },
      output: { schema: LIST_OUTPUT, render: renderList },
      async execute(args) {
        try {
          const characters = await listCharacters({ fresh: args?.fresh === true })
          const out = {
            characters: characters.map((c) => ({
              save_id: c.save_id,
              name: c.name,
              slot: c.slot,
              level: c.level ?? 0,
              summary: c.summary,
              sections: c.sections,
            })),
          }
          if (characters[0]?.savePath) out.save_path = characters[0].savePath
          return out
        } catch (err) {
          fail(err)
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'ds3_get_section',
      description:
        'Read one data section of one Dark Souls III character. Call ds3_list_saves first to get save_id and the available sections. Sections load one at a time on purpose: the save holds thousands of progress flags, and dumping them all at once would flood the context.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['save_id', 'section'],
        properties: {
          save_id: { type: 'string', description: 'save_id returned by ds3_list_saves.' },
          section: { type: 'string', description: 'Section to read: character, bosses, progress, bonfires, equipment, or inventory.' },
        },
      },
      output: { schema: SECTION_OUTPUT, render: renderSection },
      async execute(args) {
        try {
          return await readSection(args.save_id, args.section)
        } catch (err) {
          fail(err)
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'ds3_plan_route',
      description:
        'Plan which areas to visit next, in order, starting from where the player last rested. By default the targets are the areas that still have unlit bonfires. Uses the area connectivity graph; required key items and uncertain legs are reported rather than silently assumed.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          save_id: { type: 'string', description: 'Character to plan for. Omit when only one exists.' },
          from: { type: 'string', description: 'Starting area. Defaults to the last-rested bonfire area.' },
          targets: {
            type: 'array',
            items: { type: 'string' },
            description: 'Areas to visit. Defaults to every area with unlit bonfires.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            from: { type: 'string' },
            stops: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  area: { type: 'string' },
                  transport: { type: 'string', description: 'warp when a bonfire is lit there, otherwise walk.' },
                  hops: { type: 'integer' },
                  path: { type: 'array', items: { type: 'string' } },
                  missing: { type: 'array', items: { type: 'string' } },
                  requires: { type: 'array', items: { type: 'string' } },
                  uncertain: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            unreachable: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderRoute(value) }],
      },
      async execute(args) {
        try {
          return await planRouteFor(args || {})
        } catch (err) {
          fail(err)
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'ds3_diff_saves',
      description:
        'Compare the event flags of two saves of the same character and list what changed. Use it to answer "what changed since I last saved" and to label unknown flags: the bits that flipped during a play session are exactly the events that session triggered.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['save_a', 'save_b'],
        properties: {
          save_a: { type: 'string', description: 'Earlier .sl2 file path.' },
          save_b: { type: 'string', description: 'Later .sl2 file path.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            set: { type: 'array', items: FLAG_CHANGE },
            cleared: { type: 'array', items: FLAG_CHANGE },
            unknown: { type: 'array', items: FLAG_CHANGE },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderDiff(value) }],
      },
      async execute(args) {
        try {
          const r = await diffSaves(args.save_a, args.save_b)
          return { set: r.set ?? [], cleared: r.cleared ?? [], unknown: r.unknown ?? [] }
        } catch (err) {
          fail(err)
        }
      },
    }),
  )
}

function renderDiff(value) {
  const describe = (e) => e.label || (e.flag ? `旗标 ${e.flag}` : '未解码位')
  const lines = []
  lines.push(`新置位 ${value.set.length}：`)
  if (!value.set.length) lines.push('  （无）')
  for (const e of value.set) lines.push(`  + ${describe(e)}  [${e.bit}]`)
  if (value.cleared.length) {
    lines.push(`被清除 ${value.cleared.length}：`)
    for (const e of value.cleared) lines.push(`  - ${describe(e)}  [${e.bit}]`)
  }
  if (value.unknown.length) {
    lines.push(`另有 ${value.unknown.length} 个位无法映射（位于未收录的地图块，多为区域加载标记）`)
  }
  return lines.join('\n')
}

async function planRouteFor(args) {
  let saveId = args.save_id
  if (!saveId) {
    const chars = await listCharacters()
    if (!chars.length) throw new Ds3Error('no_save', '存档里没有角色')
    saveId = chars[0].save_id
  }
  const progress = await readSection(saveId, 'progress')
  const bonfires = await readSection(saveId, 'bonfires')

  const missingByArea = new Map()
  for (const label of bonfires.data.unlit || []) {
    const area = label.split(' - ')[0]
    if (!missingByArea.has(area)) missingByArea.set(area, [])
    missingByArea.get(area).push(label)
  }

  const from = args.from || progress.data.area || '传火祭祀场'
  const targets =
    Array.isArray(args.targets) && args.targets.length > 0
      ? args.targets
      : [...missingByArea.keys()]

  // Areas whose bonfire is already lit act as warp points, so the planner must
  // not report them as a walk across the connectivity graph.
  const litAreas = (bonfires.data.byArea || [])
    .filter((a) => a.lit > 0)
    .map((a) => a.area)
  const plan = planRoute({ from, targets, litAreas })
  return {
    from,
    stops: plan.stops.map((s) => ({
      area: s.area,
      transport: s.transport,
      hops: s.hops,
      path: s.path,
      missing: missingByArea.get(s.area) ?? [],
      requires: s.requires,
      uncertain: s.uncertain,
    })),
    unreachable: plan.unreachable,
    warpsAvailable: plan.warpsAvailable,
  }
}

function renderRoute(value) {
  const warpCount = value.stops.filter((s) => s.transport === 'warp').length
  const lines = [`从「${value.from}」出发：`]
  if (warpCount) {
    lines.push(`（${warpCount} 个区域已点亮篝火，可直接传送，不需要走路）`)
  }
  value.stops.forEach((s, i) => {
    const miss = s.missing.length ? `缺 ${s.missing.length} 个：${s.missing.join('、')}` : ''
    const how = s.transport === 'warp' ? '传送' : `${s.hops} 跳步行`
    lines.push(`${i + 1}. ${s.area}（${how}）${miss ? '｜' + miss : ''}`)
    if (s.requires.length) lines.push(`   前置：${s.requires.join('；')}`)
    if (s.uncertain.length) lines.push(`   存疑路段：${s.uncertain.join('；')}`)
  })
  if (value.unreachable.length) lines.push(`到不了：${value.unreachable.join('、')}`)
  return lines.join('\n')
}

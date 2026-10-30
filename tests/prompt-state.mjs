/**
 * The live state line and the tool descriptions are one contract, split across
 * two files. They already drifted once: `ds3_list_saves` said "call this first"
 * while `GUIDE_RULES` said "start from the live state below", and both arrived
 * in the same prompt on every turn. The model had no way to rank them, so it
 * silently picked one.
 *
 * The fix was to put save_id where the model already looks — the state — and to
 * stop asserting a mandatory first call. These cases fail if either half
 * regresses: a state line without save_id, or a description demanding a call
 * the state has made unnecessary.
 */
import { formatState, GUIDE_RULES } from '../src/prompt/guide.js'
import { registerTools } from '../src/tools/ds3.js'

const O = {
  save_id: 'plankton',
  character: {
    name: 'plankton',
    level: 103,
    area: '传火祭祀场',
    playtimeHours: 24.9,
    souls: 22765,
  },
  bosses: { killed: 22, total: 24, alive: ['老恶魔王', '守墓人'] },
  summary: [{ key: 'bonfires', label: '篝火', have: 79, total: 81 }],
  axes: { covenants: [{ name: 'Way of Blue', owned: true }] },
  missingByArea: {},
  reachability: { souls: [], covenants: [] },
  equipment: { weapon: "Vordt's Great Hammer +5" },
}

const fails = []
const ok = (name) => console.log(`ok: ${name}`)
const bad = (name, detail) => {
  fails.push(name)
  console.log(`FAIL: ${name} — ${detail}`)
}

// --- the state carries save_id -------------------------------------------
const state = formatState(O)
const first = state.split('\n')[0]
if (/save_id: plankton/.test(first)) ok('state 第一行带 save_id')
else bad('state 第一行带 save_id', first)

if (state.includes('老恶魔王')) ok('state 仍然列出未击败 Boss')
else bad('state 仍然列出未击败 Boss', state.slice(0, 200))

// A character whose save_id differs from its display name must still print the
// real save_id, because that is the argument ds3_get_section takes.
const renamed = formatState({ ...O, save_id: 'slot-0-key' })
if (renamed.includes('save_id: slot-0-key')) ok('save_id 与显示名不同时以 save_id 为准')
else bad('save_id 与显示名不同时以 save_id 为准', renamed.split('\n')[0])

// --- no description re-asserts a mandatory first call --------------------
const tools = []
const ctx = {
  effect: (fn) => fn(),
  tools: {
    register(spec) {
      tools.push(spec)
      return () => {}
    },
  },
}
registerTools(ctx)

if (tools.length === 4) ok('注册了 4 个基础工具')
else bad('注册了 4 个基础工具', `实际 ${tools.length}`)

const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
const listSaves = byName['ds3_list_saves']
if (listSaves && !/call this first/i.test(listSaves.description)) {
  ok('list_saves 不再声称必须首先调用')
} else {
  bad('list_saves 不再声称必须首先调用', listSaves?.description ?? 'missing')
}

const getSection = byName['ds3_get_section']
if (getSection && !/list_saves first/i.test(getSection.description)) {
  ok('get_section 不再要求先调 list_saves')
} else {
  bad('get_section 不再要求先调 list_saves', getSection?.description ?? 'missing')
}

if (getSection && /save_id/.test(getSection.description)) {
  ok('get_section 说明 save_id 已由 state 提供')
} else {
  bad('get_section 说明 save_id 已由 state 提供', getSection?.description ?? 'missing')
}

// The section enum drifted once (6 listed, 7 shipped); the hint had the same
// stale list. Both are one list away from lying to the model again.
const sectionDesc = getSection?.parameters?.properties?.section?.description ?? ''
if (/endings/.test(sectionDesc)) ok('section 描述包含 endings')
else bad('section 描述包含 endings', sectionDesc)

// --- the rules point at the state, not at a tool -------------------------
if (/Start from the live state below/i.test(GUIDE_RULES)) ok('规则仍然以 live state 为入口')
else bad('规则仍然以 live state 为入口', GUIDE_RULES.slice(0, 120))

if (fails.length) {
  console.log(`${fails.length} 项失败`)
  process.exit(1)
}
console.log('ok: state 与工具描述是同一份契约')

/**
 * First-run render test for the client bundle.
 *
 * The client is a plain script that calls window.__ModuleLoader__.load, so it
 * can be evaluated in a vm context. Its components are never exported — they
 * only reach the outside world through ctx.slots.register, which hands a test
 * the exact render callbacks the app would call. React is stubbed with a
 * call-and-walk mini renderer; hooks are positional, so a fake useState lets
 * one chosen component see an injected state and the first-run paths get
 * exercised without a fetch or a browser.
 *
 * What this protects: the failure paths are the first thing a new user sees,
 * and before this file existed they had no coverage at all — a component that
 * returned null on failure looked identical to one that worked.
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.resolve(HERE, '..', 'client.js')
const code = readFileSync(CLIENT, 'utf8')

let mod = null
const sandbox = {
  window: {
    __ModuleLoader__: { load: (m) => { mod = m } },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  },
  console,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'client.js' })

if (!mod?.factory) throw new Error('module factory was not captured')

const Fragment = Symbol('Fragment')
const noop = () => {}
const frames = []
let pending = null
let taken = false

const React = {
  Fragment,
  createElement(type, props, ...children) {
    const merged = { ...(props || {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  },
  useState(init) {
    const f = frames[frames.length - 1]
    const idx = f.i++
    if (!f.claimTried) {
      f.claimTried = true
      if (!taken && pending) {
        taken = true
        f.useOverrides = pending
      }
    }
    if (f.useOverrides && idx in f.useOverrides) return [f.useOverrides[idx], noop]
    return [typeof init === 'function' ? init() : init, noop]
  },
  useEffect: noop,
  useLayoutEffect: noop,
  useRef: (v) => ({ current: v ?? null }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}

const registered = []
const ctx = {
  slots: {
    inject(_name, fn) {
      fn()
    },
    register(spec, render) {
      registered.push({ name: spec.name, render })
      return noop
    },
  },
  inject() {},
}

mod
  .factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  })
  .apply(ctx)

function draw(node, out, depth = 0) {
  if (node == null || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const n of node) draw(n, out, depth)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return
  }
  if (typeof node !== 'object') return

  const { type, props } = node
  if (type === Fragment) {
    draw(props.children, out, depth)
    return
  }
  if (typeof type === 'function') {
    const f = { i: 0, claimTried: false, useOverrides: null }
    frames.push(f)
    let rendered
    try {
      rendered = type(props)
    } catch (err) {
      out.push(`[THREW in ${type.name || 'anonymous'}: ${err?.message ?? err}]`)
      return
    } finally {
      frames.pop()
    }
    draw(rendered, out, depth + 1)
    return
  }
  if (typeof type === 'symbol') {
    draw(props.children, out, depth)
    return
  }
  draw(props.children, out, depth + 1)
}

function renderSlot(name, props, overrides) {
  const hit = registered.find((r) => r.name === name)
  if (!hit) throw new Error(`slot not registered: ${name}`)
  pending = overrides ?? null
  taken = false
  frames.length = 0
  const out = []
  draw(hit.render(props), out)
  return out.join(' ')
}

const FAILURE = {
  loading: false,
  data: {
    ok: false,
    reason: '没有找到《黑暗之魂3》存档',
    hint: '默认查找 %APPDATA%\\DarkSoulsIII\\*\\DS30000.sl2 —— 请确认游戏至少创建过一个角色并保存过。',
    code: 'no_save',
  },
}

const OK = {
  loading: false,
  data: {
    ok: true,
    character: { name: 'plankton', level: 103, area: '灰烬墓地', playtimeHours: 26, souls: 72605 },
    bosses: { killed: 0, total: 24, alive: [] },
    areas: {},
    summary: [{ key: 'bonfires', label: '篝火', have: 1, total: 81 }],
    missingByArea: {},
    endingMarkers: [],
    equipment: {},
    stats: {},
    reachability: { souls: [], gaps: { now: [], covenantGaps: [] } },
    achievements: {},
    endings: {},
    steam: null,
    places: { items: [], total: 0 },
    edges: [],
  },
}

let failed = 0
const check = (name, text, must) => {
  const missing = must.filter((m) => !text.includes(m))
  if (missing.length) {
    failed++
    console.log(`FAIL: ${name} — 缺少 ${JSON.stringify(missing)}`)
    console.log(`   ${text.slice(0, 400)}`)
  } else {
    console.log(`ok: ${name}`)
  }
}
const checkAbsent = (name, text, mustNot) => {
  const found = mustNot.filter((m) => text.includes(m))
  if (found.length) {
    failed++
    console.log(`FAIL: ${name} — 不该出现 ${JSON.stringify(found)}`)
  } else {
    console.log(`ok: ${name}`)
  }
}

// The first screen a new user sees: reason, then the three things to check.
check('面板 · 无存档', renderSlot('main', {}, { 0: FAILURE }), [
  '读不到存档', '逐项确认', '重新读取', 'Python 3', 'cryptography', '未检查',
])
check('面板 · 有存档', renderSlot('main', {}, { 0: OK }), ['进度图', '重新读取'])

// The pill used to return null here, which read as "not installed".
const degradedClosed = renderSlot('conversation.input.left', { inputActions: {} }, { 0: FAILURE })
check('药丸 · 无存档仍然可见', degradedClosed, ['黑魂3'])
checkAbsent('药丸 · 关闭时不展开', degradedClosed, ['读不到存档'])

check(
  '药丸 · 无存档展开后有下一步',
  renderSlot('conversation.input.left', { inputActions: {} }, { 0: FAILURE, 1: true }),
  ['读不到存档', '重新读取', '侧栏有逐项检查'],
)

check(
  '药丸 · 有存档显示等级与区域',
  renderSlot('conversation.input.left', { inputActions: {} }, { 0: OK }),
  ['Lv103', '灰烬墓地'],
)

// The open popup shares one shell with the degraded state, so it needs a case
// of its own: a refactor of that shell would otherwise only break the happy
// path, which no failure test would notice.
check(
  '药丸 · 有存档展开后有进度与快捷提问',
  renderSlot('conversation.input.left', { inputActions: {} }, { 0: OK, 1: true }),
  ['plankton', 'Boss 0/24', '下一步干嘛'],
)

if (failed) {
  console.log(`${failed} 项失败`)
  process.exit(1)
}
console.log('ok: first-run paths render with a next step')

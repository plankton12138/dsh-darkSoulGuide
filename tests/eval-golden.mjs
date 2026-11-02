/**
 * 最小评测：固定问题集 + 三项指标。
 *
 * 它只测一件事：模型拿到真实存档状态后，回答里有没有出现存档里能证明的事实。
 * 不测解析器是否正确，不测攻略内容是否好看，不用 judge model。
 *
 * 两层：
 *   静态层：每条问题期望的事实，是否已经在注入的 state 里。不在 state 的，
 *           模型就必须调工具——这正是「state 该不该带这个事实」的判据。
 *   模型层：把同样的 system prompt + state + 工具交给模型，按子串断言。
 *
 * 期望值不写死。所有 truth 都从 buildProgress() 现算，换存档也能跑。
 *
 * 用法：
 *   node tests/eval-golden.mjs                    # 只跑静态层，不花钱
 *   $env:EVAL_BASE_URL="https://api.deepseek.com"
 *   $env:EVAL_API_KEY="sk-..."
 *   $env:EVAL_MODEL="deepseek-chat"
 *   node tests/eval-golden.mjs                    # 加跑模型层
 *
 * 断言是子串匹配，不是语义判断：答案里出现「37/71」就算命中。
 * 因此它只能抓到「数字/名称说错或漏说」，抓不到「说对了但推理错」。
 */
import { buildProgress } from '../src/panel/progress.js'
import { stateText, PERSONA, GUIDE_RULES } from '../src/prompt/guide.js'
import { registerTools } from '../src/tools/ds3.js'
import { registerOverviewTool } from '../src/tools/overview.js'
import { registerPlacesTool } from '../src/tools/places.js'
import { registerSourcesTool } from '../src/tools/sources.js'

const BASE = process.env.EVAL_BASE_URL?.replace(/\/+$/, '')
const KEY = process.env.EVAL_API_KEY ?? ''
const MODEL = process.env.EVAL_MODEL ?? ''
const LIVE = Boolean(BASE && MODEL)
const MAX_ROUNDS = 4

const row = (p, key) => (p.summary ?? []).find((r) => r.key === key) ?? {}

/** 每条问题的期望事实。返回空数组表示当前存档不适用，跳过。 */
const CASES = [
  {
    id: 'level-area',
    q: '我现在多少级，在哪个区域？',
    fromState: true,
    truth: (p) => [`Lv${p.character.level}`, p.character.area].filter(Boolean),
  },
  {
    id: 'rings-gap',
    q: '我还差哪些戒指？一共差多少个？',
    fromState: true,
    truth: (p) => {
      const r = row(p, 'rings')
      return r.total ? [`${r.have}/${r.total}`] : []
    },
  },
  {
    id: 'bosses-alive',
    q: '还有哪些 Boss 我没打？',
    fromState: true,
    truth: (p) => (p.bosses.alive ?? []).length ? p.bosses.alive : [],
  },
  {
    id: 'unspent-souls',
    q: '我现在能立刻兑换什么？',
    fromState: true,
    truth: (p) => (p.reachability?.souls ?? []).map((s) => s.soul),
  },
  {
    id: 'bonfires',
    q: '篝火我点亮了多少？',
    fromState: true,
    truth: (p) => {
      const r = row(p, 'bonfire')
      return r.total ? [`${r.have}/${r.total}`] : []
    },
  },
  {
    id: 'missing-areas',
    q: '哪个区域的篝火还没点全？',
    fromState: true,
    truth: (p) => Object.keys(p.missingByArea ?? {}),
  },
  {
    id: 'covenants',
    q: '我的教团进度还差几枚，分别是什么？',
    fromState: true,
    truth: (p) =>
      (p.reachability?.covenants ?? []).map((c) => `${c.held}/${c.rank1}`),
  },
  {
    id: 'steam',
    q: 'Steam 成就我还差多少个？',
    fromState: true,
    truth: (p) =>
      p.steam?.ok && p.steam.total ? [`${p.steam.unlocked}/${p.steam.total}`] : [],
  },
  {
    id: 'ending-available',
    q: '有哪些结局我现在可以触发了？',
    fromState: true,
    truth: (p) =>
      (p.endings?.endings ?? []).filter((e) => e.state === 'available').map((e) => e.name),
  },
  {
    id: 'stats',
    q: '我的九项属性分别是多少？',
    fromState: false,
    needsTool: true,
    truth: (p) => {
      const s = p.stats
      if (!s) return []
      return [['生命力', s.VIG], ['集中力', s.ATN], ['持久力', s.END], ['体力', s.VIT]]
        .filter(([, v]) => v != null)
        .map(([k, v]) => `${k} ${v}`)
    },
  },
  {
    id: 'sources',
    q: '誓约等级奖励的资料在哪查？给我链接。',
    fromState: false,
    needsTool: true,
    truth: () => ['http'],
  },
  {
    id: 'theft-of-fire',
    q: '「夺火」这个结局我拿到了吗？',
    refuse: ['无法核验', '无法验证', '没有记录', '不确定', '不知道', '看不出'],
  },
]

/** 收集工具定义，和 DSH 里注册的是同一批。 */
function collectTools() {
  const tools = []
  const ctx = {
    effect: (fn) => fn(),
    tools: { register: (spec) => { tools.push(spec); return () => {} } },
  }
  registerTools(ctx)
  registerOverviewTool(ctx)
  registerPlacesTool(ctx)
  registerSourcesTool(ctx)
  return tools
}

/** 去空白 + 转小写：模型写成「74 / 78」也算命中「74/78」。 */
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '')

const has = (text, fact) => norm(text).includes(norm(fact))

function line(ok, id, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id.padEnd(16)} ${detail}`)
}

async function callModel(messages, tools) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(KEY ? { authorization: `Bearer ${KEY}` } : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages,
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    }),
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

/** 一次提问，允许模型调用工具，最多 MAX_ROUNDS 轮。 */
async function ask(question, state, tools) {
  const messages = [
    { role: 'system', content: `${PERSONA}\n\n${GUIDE_RULES}\n\n## 实时存档状态\n${state}` },
    { role: 'user', content: question },
  ]
  let calls = 0

  for (let i = 0; i < MAX_ROUNDS; i += 1) {
    const data = await callModel(messages, tools)
    const msg = data.choices?.[0]?.message
    if (!msg) throw new Error('响应里没有 message')

    const toolCalls = msg.tool_calls ?? []
    if (!toolCalls.length) {
      return { text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''), calls }
    }

    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: toolCalls })
    for (const tc of toolCalls) {
      const spec = tools.find((t) => t.name === tc.function?.name)
      let out
      if (!spec) {
        out = `未知工具：${tc.function?.name}`
      } else {
        let args = {}
        try {
          args = JSON.parse(tc.function?.arguments || '{}')
        } catch {
          args = {}
        }
        try {
          const value = await spec.execute(args)
          const blocks = spec.output?.render?.(args, value)
          out = Array.isArray(blocks)
            ? blocks.map((b) => b.text).join('\n')
            : JSON.stringify(value)
        } catch (err) {
          out = `工具执行失败：${String(err?.message ?? err)}`
        }
      }
      calls += 1
      messages.push({ role: 'tool', tool_call_id: tc.id, content: out })
    }
  }
  return { text: `（超出 ${MAX_ROUNDS} 轮工具调用仍未给答案）`, calls }
}

async function main() {
  const p = await buildProgress()
  if (!p.ok) {
    console.log(`跳过：读不到存档 —— ${p.reason}${p.hint ? `（${p.hint}）` : ''}`)
    console.log('这个评测需要一份真实存档；没有存档时它会明确跳过，而不是假装通过。')
    return 0
  }

  const state = await stateText()
  const tools = collectTools()
  let bad = 0

  // --- 静态层 -------------------------------------------------------------
  console.log('\n== 静态层：事实是否已在 state 里 ==')
  let cover = 0
  let coverTotal = 0
  for (const c of CASES) {
    if (c.refuse || !c.fromState) continue
    const facts = c.truth(p)
    if (!facts.length) {
      console.log(`skip ${c.id.padEnd(16)} 当前存档无此项`)
      continue
    }
    coverTotal += 1
    const missing = facts.filter((f) => !has(state, f))
    if (!missing.length) {
      cover += 1
      line(true, c.id, `${facts.length} 项事实都在 state 里`)
    } else {
      line(false, c.id, `state 缺：${missing.join('、')}`)
    }
  }
  if (coverTotal) console.log(`静态覆盖：${cover}/${coverTotal} 条可直接从 state 回答`)

  if (!LIVE) {
    console.log('\n未设置 EVAL_BASE_URL / EVAL_MODEL，跳过模型层。')
    console.log('静态层只证明「模型拿得到事实」，不证明「模型用对了事实」。')
    return bad
  }

  // --- 模型层 -------------------------------------------------------------
  console.log(`\n== 模型层：${MODEL} ==`)
  let factOk = 0
  let factTotal = 0
  let toolOk = 0
  let toolTotal = 0
  let refuseOk = 0
  let refuseTotal = 0

  for (const c of CASES) {
    let answer
    try {
      answer = await ask(c.q, state, tools)
    } catch (err) {
      line(false, c.id, `调用失败：${String(err?.message ?? err)}`)
      bad += 1
      continue
    }

    if (c.needsTool) {
      toolTotal += 1
      if (answer.calls > 0) toolOk += 1
      else line(false, `${c.id}:tool`, '没有调用任何工具')
    }

    if (c.refuse) {
      refuseTotal += 1
      const ok = c.refuse.some((f) => has(answer.text, f))
      if (ok) refuseOk += 1
      else bad += 1
      line(ok, c.id, ok ? '明确说无法核验' : `没有承认无法核验：${answer.text.slice(0, 80)}`)
      continue
    }

    const facts = c.truth(p)
    if (!facts.length) {
      console.log(`skip ${c.id.padEnd(16)} 当前存档无此项`)
      continue
    }
    factTotal += 1
    const missing = facts.filter((f) => !has(answer.text, f))
    if (!missing.length) {
      factOk += 1
      line(true, c.id, `${facts.length} 项事实命中（工具 ${answer.calls} 次）`)
    } else {
      bad += 1
      line(false, c.id, `缺：${missing.join('、')}｜回答：${answer.text.slice(0, 80)}`)
    }
  }

  console.log(
    `\n事实命中 ${factOk}/${factTotal}｜工具调用 ${toolOk}/${toolTotal}｜拒绝正确 ${refuseOk}/${refuseTotal}`,
  )
  console.log('存一份这次的结果，改完提示词再跑一次，两个数字的差就是这次改动的收益。')
  return bad
}

main()
  .then((bad) => { process.exitCode = bad ? 1 : 0 })
  .catch((err) => {
    console.error(`评测崩溃：${String(err?.stack ?? err)}`)
    process.exitCode = 1
  })

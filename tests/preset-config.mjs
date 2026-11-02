/**
 * A preset row that omits a required config value does not fall back to a
 * default — it fails the plugin's schema and the whole preset loads as
 * 「加载失败」, with the field named but nothing saying which file to fix.
 *
 * That is exactly what shipped once: `tool-fs-search` and `tool-todo` were
 * mounted bare, and both of those fields are required with no default. The
 * preset looked fine as YAML and only broke when DSH tried to compose it.
 *
 * This checks the structure of cordis.patch.yml without a YAML dependency, so
 * it runs anywhere the rest of the suite runs. It is deliberately a structural
 * check, not a parser: rows are read as "a `- id:` line and everything up to
 * the next one", which matches this file's shape.
 */
import { readFileSync } from 'node:fs'

const text = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

/** Required fields, from each plugin's own schema. No defaults exist for these. */
const REQUIRED = {
  '@deepseek-ai/dsh-tool-fs-search': ['sampleOverCapGlobResults'],
  '@deepseek-ai/dsh-tool-todo': ['allowParallelInProgress'],
}

const rows = []
let cur = null
for (const line of text.split(/\r?\n/)) {
  const start = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line)
  if (start) {
    if (cur) rows.push(cur)
    cur = { id: start[1], lines: [line] }
    continue
  }
  if (cur) cur.lines.push(line)
}
if (cur) rows.push(cur)

const fails = []
const ok = (name) => console.log(`ok: ${name}`)
const bad = (name, detail) => {
  fails.push(name)
  console.log(`FAIL: ${name} — ${detail}`)
}

// `name:` is quoted for scoped packages and bare for everything else, so both
// forms have to parse — an earlier version only matched quotes and quietly
// reported three real rows as nameless.
const NAME_RE = /^\s*name:\s*(?:'([^']+)'|"([^"]+)"|(\S+))\s*$/m

const parsed = rows.map((r) => {
  const body = r.lines.join('\n')
  const m = NAME_RE.exec(body)
  return { id: r.id, name: m ? (m[1] ?? m[2] ?? m[3]) : null, body }
})

const nameless = parsed.filter((r) => !r.name).map((r) => r.id)
if (nameless.length) bad('每个插件行都有 name', `缺 name：${nameless.join('、')}`)
else ok(`每个插件行都有 name（${parsed.length} 行）`)

// The two known-required configs, checked only when the plugin is mounted.
let checked = 0
for (const [plugin, fields] of Object.entries(REQUIRED)) {
  const row = parsed.find((r) => r.name === plugin)
  if (!row) {
    console.log(`  · ${plugin} 未挂载，跳过`)
    continue
  }
  checked++
  const missing = fields.filter((f) => !new RegExp(`^\\s*${f}:`, 'm').test(row.body))
  if (missing.length) {
    bad(
      `${plugin} 的必填配置`,
      `缺 ${missing.join('、')} —— 这个插件没有默认值，缺了会让整个预设加载失败`,
    )
  } else {
    ok(`${plugin} 的必填配置齐全`)
  }
}
if (!checked) bad('至少检查到一个必填插件', 'REQUIRED 里的插件一个都没挂载，测试形同虚设')

// A guard that matches nothing always passes. Prove the row splitter can find
// rows that are definitely there before trusting any negative result above.
const guideRows = parsed.filter((r) => r.name === 'dsh-darksouls-guide')
if (guideRows.length < 2) {
  bad(
    '行解析自身有效',
    `只找到 ${guideRows.length} 个 dsh-darksouls-guide 行，预期 2 个（方案行 + 预设行）`,
  )
} else {
  ok('行解析自身有效（找到两处挂载）')
}

// The two mounts are the whole containment design: the profile row serves the
// panel to every session, the preset row serves tools to preset sessions only.
const hasTools = guideRows.some((r) => /^\s*tools:\s*true$/m.test(r.body))
const hasPanel = guideRows.some((r) => /^\s*panel:\s*true$/m.test(r.body))
if (hasTools && hasPanel) {
  ok('两处挂载分工正确（一处开工具、一处开面板）')
} else {
  bad('两处挂载分工正确', `tools:true=${hasTools}，panel:true=${hasPanel}`)
}

if (fails.length) {
  console.log(`${fails.length} 项失败`)
  process.exit(1)
}
console.log('ok: 预设配置完整')

/**
 * What actually ships to npm, checked before it is published.
 *
 * The package once packed to 42 MB: `files` listed `tests/**`, and npm honours
 * that over `.gitignore`, so four real DS3 saves, a Dark Souls Remastered save
 * and a steam_autocloud.vdf carrying the Steam account id were all about to go
 * to a public registry. `.gitignore` had been fixed for exactly this once and
 * only on the git side — git and npm apply two different ignore rules, and a
 * save file is personal data on both.
 *
 * So this asserts on the real tarball listing instead of on the config, because
 * the config is what was wrong. Run it before `npm publish`; it is not part of
 * the published package (tests are deliberately excluded — the fixtures they
 * need cannot be shipped, so a published copy of the suite would fail for
 * anyone who ran it).
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const fails = []
const ok = (name) => console.log(`ok: ${name}`)
const bad = (name, detail) => {
  fails.push(name)
  console.log(`FAIL: ${name} — ${detail}`)
}

let raw
try {
  raw = execSync('npm pack --dry-run --json', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
} catch {
  console.log('FAIL: 无法运行 npm pack —— 这条检查需要 npm 在 PATH 上')
  process.exit(1)
}

let meta
try {
  meta = JSON.parse(raw)
} catch {
  console.log('FAIL: npm pack --json 的输出无法解析')
  console.log(raw.slice(0, 300))
  process.exit(1)
}

const info = meta?.[0]
if (!info) {
  console.log('FAIL: npm pack 没有返回任何包信息')
  process.exit(1)
}

const paths = info.files.map((f) => f.path)
const unpackedMb = info.unpackedSize / 1048576

// --- nothing personal, nothing generated ---------------------------------
const FORBIDDEN = [
  [/\.sl2$/i, '存档文件'],
  [/\.vdf$/i, 'Steam 云同步元数据（含 account id）'],
  [/__pycache__|\.pyc$/i, 'Python 字节码'],
]

// Make the guard prove itself. A pattern that matches nothing always reports
// "clean", which is the one failure mode this whole file exists to prevent —
// `\\.pyc` (a literal backslash) sat here unnoticed because no .pyc was ever
// in the package for it to miss.
const MUST_CATCH = [
  'tests/fixtures/ds3/DS30000.sl2',
  'tests/fixtures/saves/DARK SOULS REMASTERED/1/DRAKS0005.sl2',
  'tests/fixtures/saves/DARK SOULS REMASTERED/1/steam_autocloud.vdf',
  'tools/ds3/__pycache__/dump_save.cpython-313.pyc',
]
const blind = MUST_CATCH.filter((s) => !FORBIDDEN.some(([re]) => re.test(s)))
if (blind.length) {
  bad('禁入规则自身有效', `这些路径没被规则拦住：${blind.join('、')}`)
} else {
  ok('禁入规则自身有效')
}
const leaked = paths.filter((p) => FORBIDDEN.some(([re]) => re.test(p)))
if (leaked.length) {
  bad('包里没有存档或个人元数据', leaked.join('、'))
} else {
  ok('包里没有存档或个人元数据')
}

// --- a size a registry will accept without question ----------------------
if (unpackedMb < 2) {
  ok(`体积合理（${unpackedMb.toFixed(2)} MB）`)
} else {
  bad('体积合理', `${unpackedMb.toFixed(2)} MB —— 很可能是又把夹具打进去了`)
}

// --- the files the plugin needs at runtime -------------------------------
const REQUIRED = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'LICENSE',
  'NOTICE.md',
  'README.md',
  'tools/ds3/dump_save.py',
  'data/reference/ds3/items.json',
]
const missing = REQUIRED.filter((r) => !paths.includes(r))
if (missing.length) {
  bad('运行时文件齐全', `缺 ${missing.join('、')}`)
} else {
  ok('运行时文件齐全')
}

// The parser is spawned as a subprocess by absolute path; a published package
// without it would install cleanly and then fail on every question.
if (paths.some((p) => p.startsWith('tools/') && !p.endsWith('.py'))) {
  bad('tools/ 下只有解析器脚本', '混入了非 .py 文件')
} else {
  ok('tools/ 下只有解析器脚本')
}

// --- no tests: they need fixtures that are correctly not shipped ---------
if (paths.some((p) => p.startsWith('tests/'))) {
  bad('不打进测试', 'tests/ 出现在包里 —— 它依赖不会随包发布的夹具')
} else {
  ok('不打进测试')
}

// --- publishable at all ---------------------------------------------------
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
if (pkg.private === true) {
  bad('可以发布', 'package.json 仍是 private: true，npm 会直接拒绝')
} else {
  ok('可以发布')
}

if (!pkg.engines?.dsh) {
  bad('声明了宿主版本', '缺 engines.dsh —— 市场会显示「未声明兼容性」')
} else {
  ok(`声明了宿主版本（engines.dsh: ${pkg.engines.dsh}）`)
}

if (fails.length) {
  console.log(`${fails.length} 项失败`)
  process.exit(1)
}
console.log(`ok: 发布包干净（${paths.length} 个文件，${unpackedMb.toFixed(2)} MB）`)

/**
 * DS3 save access layer.
 *
 * Everything that can fail lives here: python discovery, subprocess failure,
 * missing save, corrupt container. Tools above only ever see parsed objects.
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.resolve(HERE, '..', '..', '..', 'tools', 'ds3', 'dump_save.py')
const PYTHON_CANDIDATES = ['python', 'python3', 'py']

export class Ds3Error extends Error {
  constructor(code, message, hint) {
    super(message)
    this.name = 'Ds3Error'
    this.code = code
    this.hint = hint
  }
}

function classifyFailure(stderr, stdout, exitCode) {
  const text = `${stderr || ''}\n${stdout || ''}`
  if (/no DS3 save found/i.test(text)) {
    return new Ds3Error(
      'no_save',
      '没有找到《黑暗之魂3》存档',
      '默认查找 %APPDATA%\\DarkSoulsIII\\*\\DS30000.sl2 —— 请确认游戏至少创建过一个角色并保存过。',
    )
  }
  if (/ModuleNotFoundError|ImportError/.test(text)) {
    return new Ds3Error(
      'dependency_missing',
      '解析器缺少 Python 依赖',
      '需要 cryptography：pip install cryptography',
    )
  }
  if (/not a BND4 container/.test(text)) {
    return new Ds3Error('unsupported_version', '存档不是可识别的 BND4 容器', '可能不是 Dark Souls III 的存档文件。')
  }
  if (/Traceback/.test(text)) {
    return new Ds3Error('parse_error', `解析存档失败（退出码 ${exitCode}）`, text.trim().split('\n').slice(-3).join(' | '))
  }
  return new Ds3Error('unknown', `解析器异常退出（退出码 ${exitCode}）`, text.trim().slice(0, 400))
}

async function runParser(args) {
  const missing = []
  for (const exe of PYTHON_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync(exe, [SCRIPT, '--json', ...args], {
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      })
      return stdout
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) {
        missing.push(exe)
        continue
      }
      throw classifyFailure(err?.stderr, err?.stdout, err?.code)
    }
  }
  throw new Ds3Error(
    'python_missing',
    '没有找到可用的 Python 解释器',
    `已尝试：${PYTHON_CANDIDATES.join(', ')}；也可以直接跑 python ${SCRIPT} 验证。`,
  )
}

let cache = null
const CACHE_MS = 5_000

/** All characters across locally found DS3 saves. */
export async function listCharacters({ fresh = false } = {}) {
  const now = Date.now()
  if (!fresh && cache && now - cache.at < CACHE_MS) return cache.value

  const stdout = await runParser([])
  let games
  try {
    games = JSON.parse(stdout)
  } catch {
    throw new Ds3Error('parse_error', '解析器返回了无法解析的 JSON', stdout.slice(0, 200))
  }

  const characters = games.map((g) => ({
    save_id: g.identity.saveName,
    name: g.identity.saveName,
    slot: g.identity.slot,
    level: g.identity.extra?.level ?? null,
    summary: g.summary,
    sections: Object.keys(g.sections || {}),
    savePath: g.source?.save ?? null,
    gameState: g,
  }))

  cache = { at: now, value: characters }
  return characters
}

/** Compare the event flags of two saves of the same character. */
export async function diffSaves(saveA, saveB) {
  const stdout = await runParser(['--diff', saveA, saveB])
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Ds3Error('parse_error', '差分输出不是合法 JSON', stdout.slice(0, 200))
  }
}

/** One section of one character, in GameState shape. */
export async function readSection(saveId, section) {
  const characters = await listCharacters({ fresh: true })
  const hit = characters.find(
    (c) => c.save_id === saveId || c.name === saveId || String(c.slot) === String(saveId),
  )
  if (!hit) {
    throw new Ds3Error(
      'unknown_save',
      `没有叫「${saveId}」的角色`,
      `现有角色：${characters.map((c) => c.save_id).join('、') || '（无）'}`,
    )
  }
  const available = Object.keys(hit.gameState.sections || {})
  const data = hit.gameState.sections?.[section]
  if (!data) {
    throw new Ds3Error(
      'unknown_section',
      `角色「${hit.name}」没有名为「${section}」的数据切片`,
      `可用切片：${available.join('、')}。切片名要完全一致，请从这份列表里选。`,
    )
  }
  return { save_id: hit.save_id, section, description: data.description, data: data.data }
}

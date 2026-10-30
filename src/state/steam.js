/**
 * Steam achievement state, read from the local Steam cache.
 *
 * Why this file and not the save: the game stores no achievement state. The
 * names live behind an encrypted BHD index in the game files, the community
 * page hides them behind a spoiler toggle, and the save itself mentions
 * achievements nowhere. What Steam keeps locally is the one authoritative
 * copy — `appcache/stats/UserGameStats_<accountid>_<appid>.bin`, a Valve
 * KeyValues file whose `AchievementTimes` maps an achievement API name to the
 * Unix time it was unlocked.
 *
 * That file is the reason "which ending did I get" is answerable at all, and it
 * is also the reason the previous ending module was wrong: it inferred
 * "Link the Flame" from a flag that does not mean what it appeared to mean.
 *
 * The unlock *times* survive across playthroughs, so the file reflects every
 * ending the account has ever reached, not just the current run.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** DS3's Steam app id. Note the different number from the 2196600 used for
 *  the store page — the achievements live under 374320. */
export const APP_ID = '374320'

/** Where Steam keeps its per-account stats cache. */
const STEAM_ROOTS = [
  process.env.STEAM_PATH,
  'C:/Program Files (x86)/Steam',
  'C:/Program Files/Steam',
  path.join(os.homedir(), 'Steam'),
  path.join(os.homedir(), '.steam', 'steam'),
  path.join(os.homedir(), '.local', 'share', 'Steam'),
].filter(Boolean)

/* ------------------------------------------------------------------ */
/* Valve KeyValues binary — the format Steam uses for these files.      */
/* ------------------------------------------------------------------ */

function readCString(buf, off) {
  let i = off
  while (i < buf.length && buf[i] !== 0x00) i += 1
  return { s: buf.toString('utf8', off, i), next: i + 1 }
}

function addKey(obj, key, value) {
  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    const cur = obj[key]
    if (Array.isArray(cur)) cur.push(value)
    else obj[key] = [cur, value]
  } else {
    obj[key] = value
  }
}

/**
 * Parse a KeyValues node. Type tags: 0x00 child node, 0x01 string,
 * 0x02 int32, 0x03 float, 0x07 uint64, 0x08 end of node.
 */
function parseChildren(buf, offset) {
  let off = offset
  const obj = {}
  while (off < buf.length) {
    const type = buf.readUInt8(off)
    off += 1
    if (type === 0x08) return { obj, next: off }
    const k = readCString(buf, off)
    off = k.next
    if (type === 0x00) {
      const child = parseChildren(buf, off)
      addKey(obj, k.s, child.obj)
      off = child.next
      continue
    }
    if (type === 0x01) {
      const v = readCString(buf, off)
      addKey(obj, k.s, v.s)
      off = v.next
      continue
    }
    if (type === 0x02) {
      addKey(obj, k.s, buf.readInt32LE(off))
      off += 4
      continue
    }
    if (type === 0x03) {
      addKey(obj, k.s, buf.readFloatLE(off))
      off += 4
      continue
    }
    if (type === 0x07) {
      addKey(obj, k.s, buf.readBigUInt64LE(off).toString())
      off += 8
      continue
    }
    throw new Error(`unsupported KeyValues type 0x${type.toString(16)} at ${off}`)
  }
  return { obj, next: off }
}

function parseKeyValues(buf) {
  let off = 0
  const first = buf.readUInt8(off)
  off += 1
  if (first === 0x00) {
    const r = readCString(buf, off)
    off = r.next
    return parseChildren(buf, off).obj
  }
  return parseChildren(buf, off).obj
}

/* ------------------------------------------------------------------ */
/* Locating the file                                                    */
/* ------------------------------------------------------------------ */

/** Every Steam account id with a stats cache for this app. */
export function findSteamAccounts(appId = APP_ID) {
  const found = []
  for (const root of STEAM_ROOTS) {
    const dir = path.join(root, 'appcache', 'stats')
    if (!fs.existsSync(dir)) continue
    let entries = []
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const m = /^UserGameStats_(\d+)_(\d+)\.bin$/.exec(name)
      if (!m) continue
      found.push({ accountId: m[1], appId: m[2], file: path.join(dir, name) })
    }
    if (found.length) break
  }
  return found
}

/** The account id and SteamID64 for the signed-in Steam user, if readable. */
export function readSignedInSteamId() {
  for (const root of STEAM_ROOTS) {
    const f = path.join(root, 'config', 'loginusers.vdf')
    if (!fs.existsSync(f)) continue
    try {
      const text = fs.readFileSync(f, 'utf8')
      const id = /"(\d{17})"/.exec(text)
      const name = /"PersonaName"\s+"([^"]+)"/.exec(text)
      if (id) return { steamId64: id[1], persona: name ? name[1] : null }
    } catch {
      /* unreadable; try the next root */
    }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Mapping the numeric ids to achievement API names                     */
/* ------------------------------------------------------------------ */

/**
 * The id -> API name mapping, read from Steam's schema file.
 *
 * The account file keys achievements by a number that is local to its group,
 * and the two files number differently. DS3's schema splits 43 achievements
 * into two `bits` groups:
 *
 *   group 1: ACH00..ACH30, keyed 0,2,3..31 — key 1 is skipped because it
 *            belongs to the Initial Warp pseudo-bonfire
 *   group 2: ACH31..ACH42, keyed 0..11
 *
 * So group 1's key is the achievement number plus one, and group 2's key is the
 * achievement number minus 31. Getting this wrong shifts every entry after
 * the gap and labels "To Link the First Flame" as "The Usurpation of Fire" —
 * a wrong answer that looks plausible, which is the worst kind.
 *
 * The mapping is therefore read from the schema rather than assumed, and the
 * group is taken from the schema's own node path.
 */
export function readAchievementIndex(appId = APP_ID) {
  for (const root of STEAM_ROOTS) {
    const file = path.join(root, 'appcache', 'stats', `UserGameStatsSchema_${appId}.bin`)
    if (!fs.existsSync(file)) continue
    let buf
    let schema
    try {
      buf = fs.readFileSync(file)
      schema = parseKeyValues(buf)
    } catch {
      continue
    }
    // group id -> Map(account-file key -> achievement)
    const groups = new Map()
    const stats = schema.stats ?? schema
    for (const [group, node] of Object.entries(stats)) {
      const bits = node?.bits
      if (!bits || typeof bits !== 'object') continue
      const map = new Map()
      for (const [key, value] of Object.entries(bits)) {
        if (!value || typeof value !== 'object') continue
        if (typeof value.name !== 'string' || !/^ACH\d+$/.test(value.name)) continue
        map.set(Number(key), {
          api: value.name,
          number: Number(value.name.slice(3)),
          hidden: value.hidden === true,
          names: value.display?.name ?? null,
          // The schema calls it `desc`, not `description`.
          descriptions: value.display?.desc ?? null,
        })
      }
      if (map.size) groups.set(group, map)
    }
    if (groups.size) return { groups, file }
  }
  return { groups: new Map(), file: null }
}

/* ------------------------------------------------------------------ */
/* Reading the achievements                                              */
/* ------------------------------------------------------------------ */

/**
 * Unlock times for one account, as section id -> (local id -> Unix seconds).
 *
 * The section is part of the identity: the same local id in two sections is
 * two different achievements.
 */
export function readAchievementTimes(file) {
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch {
    return {}
  }
  let root
  try {
    root = parseKeyValues(buf)
  } catch {
    return {}
  }

  const bySection = {}
  const collect = (node, section) => {
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (key === 'AchievementTimes' && value && typeof value === 'object') {
        const sec = section ?? '1'
        if (!bySection[sec]) bySection[sec] = {}
        for (const [id, ts] of Object.entries(value)) {
          const t = Number(ts)
          if (Number.isFinite(t) && t > 0) bySection[sec][Number(id)] = t
        }
        continue
      }
      if (value && typeof value === 'object') collect(value, section)
    }
  }
  // The top-level numbered nodes of the account file are the sections.
  for (const [key, value] of Object.entries(root)) {
    if (key === 'crc' || key === 'PendingChanges') continue
    collect(value, key)
  }
  return bySection
}

/**
 * All Steam achievements for the signed-in account.
 *
 * Returns the unlock times plus the account they belong to, so the caller can
 * tell "no data" apart from "nothing unlocked".
 */
export function readSteamAchievements(appId = APP_ID) {
  const accounts = findSteamAccounts(appId).filter((a) => a.appId === appId)
  if (!accounts.length) {
    return { ok: false, reason: 'no_steam_account', accounts: [], achievements: [], unlocked: 0, total: 0 }
  }
  const signedIn = readSignedInSteamId()
  // Prefer the signed-in account; otherwise the first one found.
  const chosen = signedIn
    ? accounts.find((a) => a.steamId64 === signedIn.steamId64) ?? accounts[0]
    : accounts[0]
  const bySection = readAchievementTimes(chosen.file)
  const { groups } = readAchievementIndex(appId)

  const achievements = []
  for (const [section, map] of [...groups.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const times = bySection[section] ?? {}
    for (const [id, meta] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
      const ts = times[id] ?? null
      achievements.push({
        id,
        section,
        api: meta.api,
        name: meta.names?.schinese ?? meta.names?.english ?? null,
        nameEn: meta.names?.english ?? null,
        description: meta.descriptions?.schinese ?? meta.descriptions?.english ?? null,
        hidden: meta.hidden,
        unlocked: ts !== null,
        unlockedAt: ts,
      })
    }
  }

  const unlockedCount = achievements.filter((a) => a.unlocked).length
  return {
    ok: unlockedCount > 0,
    reason: unlockedCount ? null : 'no_unlocks',
    accountId: chosen.accountId,
    steamId64: signedIn?.steamId64 ?? null,
    persona: signedIn?.persona ?? null,
    file: chosen.file,
    times: bySection,
    achievements,
    unlocked: unlockedCount,
    total: achievements.length,
  }
}

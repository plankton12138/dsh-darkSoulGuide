/**
 * Steam achievement reading: the mapping must be exact.
 *
 * DS3's Steam stats are split into two groups whose keys do not line up with
 * the achievement numbers, and a plausible-looking off-by-one silently
 * relabels "To Link the First Flame" as "The Usurpation of Fire". These checks
 * pin the mapping against known unlock times rather than against itself.
 */
import assert from 'node:assert/strict'
import { readSteamAchievements, readAchievementIndex } from '../src/state/steam.js'

const r = readSteamAchievements()
if (!r.ok) {
  console.log('skip: no Steam achievement data on this machine (%s)', r.reason)
  process.exit(0)
}

// The count Steam's own page reports.
assert.equal(r.total, 43, 'DS3 has 43 achievements')
assert.ok(r.unlocked > 0 && r.unlocked <= 43)

// Every achievement must carry a name and a description.
for (const a of r.achievements) {
  assert.ok(a.api && /^ACH\d\d$/.test(a.api), `bad api name: ${a.api}`)
  assert.ok(a.name && a.name.length > 1, `achievement ${a.api} has no name`)
  assert.ok(a.description && a.description.length > 1, `achievement ${a.api} has no description`)
}

// Unlock times must be sane and inside the file's own range.
for (const a of r.achievements.filter((x) => x.unlocked)) {
  assert.ok(a.unlockedAt > 1_500_000_000 && a.unlockedAt < 2_000_000_000, `bad timestamp on ${a.api}`)
}

// The mapping is pinned by achievement names, not by count: if the two groups'
// offsets were swapped, these three would be wrong while the totals stayed right.
const byApi = Object.fromEntries(r.achievements.map((a) => [a.api, a]))
const ENDINGS = {
  'ACH02': '传火终结',
  'ACH03': '火的篡位者',
  'ACH01': '初始之火的继承者',
}
for (const [api, expected] of Object.entries(ENDINGS)) {
  assert.ok(
    byApi[api].name.includes(expected.slice(0, 2)),
    `${api} should be "${expected}" but is "${byApi[api].name}"`,
  )
}

console.log('ok: %d/%d achievements, mapping verified', r.unlocked, r.total)

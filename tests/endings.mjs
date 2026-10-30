/**
 * Endings: four of them, three achievements.
 *
 * An earlier version said DS3 had three endings, having read the number of
 * ending achievements (3) as the number of endings. 夺火 (theft of fire) is a
 * real fourth ending with no achievement and no save marker, so it can only be
 * reported as unverifiable — counting it either as reached or as missing would
 * both be a guess.
 *
 * These checks pin: four endings, three trackable, the corrected ACH01/ACH02
 * mapping, and that 夺火 is never called done or missing.
 */
import assert from 'node:assert/strict'
import { endingStatus } from '../src/state/endings.js'

const LORDS_DEAD = ['薪王们的化身']

const ach = (api, unlocked) => ({ api, name: api, unlocked, unlockedAt: unlocked ? 1786182828 : null })

// --- four endings, but only three can be verified ----------------------------
{
  const s = await endingStatus({
    achievements: [ach('ACH01', false), ach('ACH02', true), ach('ACH03', false)],
    killedBosses: LORDS_DEAD,
  })
  const byId = Object.fromEntries(s.endings.map((e) => [e.id, e]))

  assert.equal(s.total, 4, 'DS3 has four endings')
  assert.equal(s.trackableTotal, 3, 'only three have achievements')
  assert.deepEqual(s.untrackableNames, ['夺火'], 'theft of fire is the untrackable one')

  assert.equal(byId['end-of-fire'].state, 'done', 'ACH02 is 传火终结')
  assert.equal(byId['link-the-flame'].state, 'available', 'ACH01 is still open')
  assert.equal(byId['usurpation'].state, 'available', 'ACH03 is still open')

  // 夺火 must never be claimed either way.
  assert.equal(byId['theft-of-fire'].state, 'unverifiable')
  assert.equal(byId['theft-of-fire'].achievement, null)
  assert.ok(
    !s.reachedNames.includes('夺火'),
    'theft of fire must not be counted as reached without evidence',
  )
}

// --- 夺火 is a distinct ending, not a synonym of 火的篡位者 ------------------
{
  const s = await endingStatus({ achievements: [], killedBosses: LORDS_DEAD })
  const byId = Object.fromEntries(s.endings.map((e) => [e.id, e]))
  assert.notEqual(
    byId['theft-of-fire'].condition,
    byId['usurpation'].condition,
    'theft of fire and usurpation are different routes',
  )
  assert.match(byId['usurpation'].alias, /Usurpation/i)
  assert.match(byId['theft-of-fire'].alias, /Theft of Fire/i)
}

// --- the Chinese name is a trap, pinned so nobody "fixes" it back -----------
{
  const s = await endingStatus({
    achievements: [ach('ACH01', true), ach('ACH02', false), ach('ACH03', false)],
    killedBosses: LORDS_DEAD,
  })
  const byId = Object.fromEntries(s.endings.map((e) => [e.id, e]))
  assert.equal(byId['link-the-flame'].state, 'done', 'ACH01 is To Link the First Flame')
  assert.equal(byId['end-of-fire'].state, 'available', '传火终结 is the Fire Keeper ending, not ACH01')
  for (const e of s.endings) {
    assert.ok(e.alias && e.alias.length > 3, `${e.id} should carry its English alias`)
  }
}

// --- the save decides reachability ------------------------------------------
{
  const s = await endingStatus({ achievements: [], killedBosses: [] })
  for (const e of s.endings) {
    assert.equal(e.state, 'locked', `${e.id} should be locked before the final boss`)
  }
}

// --- no Steam data means no claim of having reached anything ----------------
{
  const s = await endingStatus({ achievements: [], killedBosses: LORDS_DEAD })
  assert.equal(s.reached, 0, 'nothing may be called reached without evidence')
  for (const e of s.endings) {
    assert.notEqual(e.state, 'done', `${e.id} must not be called done without evidence`)
  }
}

// --- every ending carries its condition and its evidence --------------------
{
  const s = await endingStatus({
    achievements: [ach('ACH02', true)],
    killedBosses: LORDS_DEAD,
  })
  for (const e of s.endings) {
    assert.ok(e.condition && e.condition.length > 5, `${e.id} has no condition`)
    assert.ok(e.evidence && e.evidence.length > 5, `${e.id} has no evidence`)
  }
}

console.log('ok: four endings, three verifiable, 夺火 never guessed')

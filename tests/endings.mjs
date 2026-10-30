/**
 * Endings: the achievement decides what was reached, the save decides what is
 * still open.
 *
 * An earlier version inferred the reached endings from a save flag and was
 * wrong — it read a flag named after the First Flame as a record of that flame
 * being lit, while the player had finished a different ending months earlier.
 * These checks pin the corrected split, and the corrected mapping: 传火终结 is
 * ACH02 (The End of Fire, the Fire Keeper ending), not ACH01.
 */
import assert from 'node:assert/strict'
import { endingStatus } from '../src/state/endings.js'

const LORDS_DEAD = ['薪王们的化身']

const ach = (api, unlocked) => ({ api, name: api, unlocked, unlockedAt: unlocked ? 1786182828 : null })

// --- what was reached comes from the achievements ----------------------------
{
  const s = await endingStatus({
    achievements: [ach('ACH01', false), ach('ACH02', true), ach('ACH03', false)],
    killedBosses: LORDS_DEAD,
  })
  const byId = Object.fromEntries(s.endings.map((e) => [e.id, e]))

  assert.equal(s.total, 3, 'DS3 has three story endings')
  assert.equal(byId['end-of-fire'].state, 'done', 'ACH02 is 传火终结')
  assert.equal(byId['link-the-flame'].state, 'available', 'ACH01 is still open')
  assert.equal(byId['usurpation'].state, 'available', 'ACH03 is still open')
  assert.equal(s.reached, 1)
  assert.deepEqual(s.reachedNames, ['传火终结'])
}

// --- the Chinese name is a trap, pinned here so nobody "fixes" it back -------
{
  const s = await endingStatus({
    achievements: [ach('ACH01', true), ach('ACH02', false), ach('ACH03', false)],
    killedBosses: LORDS_DEAD,
  })
  const byId = Object.fromEntries(s.endings.map((e) => [e.id, e]))
  assert.equal(byId['link-the-flame'].state, 'done', 'ACH01 is To Link the First Flame')
  assert.equal(byId['end-of-fire'].state, 'available', '传火终结 is the Fire Keeper ending, not ACH01')
  for (const e of s.endings) {
    assert.ok(
      /The End of Fire|To Link the First Flame|The Usurpation/i.test(e.alias),
      `${e.id} should carry its English alias to disambiguate`,
    )
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
  for (const e of s.endings) {
    assert.notEqual(e.state, 'done', `${e.id} must not be called done without evidence`)
    assert.equal(e.state, 'available')
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

console.log('ok: endings use achievements for "reached" and the save for "still open"')

/**
 * Endings: what the save can and cannot say.
 *
 * The important property is not that the counts are right but that no ending
 * is ever reported as done without evidence. Two of the four endings leave no
 * readable mark, so a "done" verdict for them would be a guess.
 */
import assert from 'node:assert/strict'
import { endingStatus } from '../src/state/endings.js'

const FLAME = '14100002'
const LORDS = '14100800'
const GAEL = '15110800'

// --- the real save: flame not lit, Lords of Cinder dead ---
{
  const s = await endingStatus({
    flags: { [FLAME]: 0, [LORDS]: 1, [GAEL]: 1 },
    killedBosses: ['奴仆骑士盖尔'],
  })

  const byId = Object.fromEntries(s.endings.map((e) => [e.id, e]))
  assert.equal(byId['lord-of-cinder'].state, 'done', 'Lord of Cinder should be done')
  assert.equal(byId['link-the-flame'].state, 'available', 'Link the Flame should be available')
  assert.equal(byId['age-of-darkness'].state, 'possible', 'DLC2 ending is not confirmable')
  assert.equal(byId['usurpation'].state, 'possible', 'Usurpation is not confirmable')

  // The two indistinguishable endings must never be reported as done.
  for (const id of ['age-of-darkness', 'usurpation']) {
    assert.notEqual(byId[id].state, 'done', `${id} must never be reported as done`)
  }

  // Every ending must carry the evidence it was judged on.
  for (const e of s.endings) {
    assert.ok(e.evidence && e.evidence.length > 5, `${e.id} has no evidence`)
    assert.ok(e.condition && e.condition.length > 5, `${e.id} has no condition`)
  }
}

// --- flame lit: that ending is confirmed, and Lord of Cinder is not ---
{
  const s = await endingStatus({
    flags: { [FLAME]: 1, [LORDS]: 1, [GAEL]: 1 },
    killedBosses: ['奴仆骑士盖尔'],
  })
  const byId = Object.fromEntries(s.endings.map((e) => [e.id, e]))
  assert.equal(byId['link-the-flame'].state, 'done', 'Link the Flame should be confirmed')
  assert.equal(byId['lord-of-cinder'].state, 'ambiguous', 'Lord of Cinder must not also claim done')
}

// --- nothing done yet ---
{
  const s = await endingStatus({ flags: {}, killedBosses: [] })
  for (const e of s.endings) {
    assert.equal(e.state, 'locked', `${e.id} should be locked on a fresh character`)
  }
}

// --- the module must never publish a completion count it cannot support ---
{
  const s = await endingStatus({
    flags: { [FLAME]: 0, [LORDS]: 1, [GAEL]: 1 },
    killedBosses: [],
  })
  assert.equal(s.total, 4)
  assert.ok(s.confirmed <= 1, 'at most one ending is confirmable from this save')
}

console.log('ok: endings report evidence and never overcount')

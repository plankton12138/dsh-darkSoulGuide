/**
 * Place guides: three parts, and the two honesty rules that matter.
 *
 * The failure this guards against is a guide that sounds confident and sends
 * the player on a wasted trip. Two specific ways that happens:
 *
 *   1. A prerequisite the save cannot see (a gesture) gets reported as
 *      satisfied, so the player walks to the tower and cannot interact.
 *   2. A single-source detail gets stated as settled fact.
 *
 * So: unverifiable prerequisites must read `unknown`, never `owned`; medium
 * confidence must carry a warning; and a `missing` status must be backed by an
 * actual save check, not by absence of evidence.
 */
import assert from 'node:assert/strict'
import { findPlaces, allPlaces } from '../src/state/places.js'

const NO_COVENANTS = { covenantNames: new Set() }
const HAS_DARKMOON = { covenantNames: new Set(['Blade of the Darkmoon']) }

// --- the three parts are all present ----------------------------------------
{
  const r = await findPlaces('暗月之剑', NO_COVENANTS)
  assert.equal(r.matches.length, 1, 'expected the Darkmoon entry')
  const g = r.matches[0]

  // ① status
  assert.equal(g.status.state, 'missing')
  assert.equal(g.status.verified, true, 'covenant membership IS save-verifiable')
  assert.ok(g.status.evidence.length > 5)

  // ② route
  assert.ok(g.where?.bonfireName, 'a guide must name the bonfire to start from')
  assert.ok(g.steps.length >= 2, 'a guide must have walkable steps')

  // ③ caveats
  assert.ok(g.warnings.length > 0, 'a missable guide must warn')
  assert.ok(g.sources.length > 0, 'a guide must cite sources')
}

// --- status follows the save, both ways -------------------------------------
{
  const r = await findPlaces('Blade of the Darkmoon', HAS_DARKMOON)
  const g = r.matches[0]
  assert.equal(g.status.state, 'owned', 'joined covenant must read as owned')
}

// --- an unverifiable prerequisite is unknown, never assumed satisfied -------
{
  const r = await findPlaces('暗月之剑', NO_COVENANTS)
  const g = r.matches[0]
  const gesture = g.requires.find((x) => x.kind === 'gesture')
  assert.ok(gesture, 'the Darkmoon guide must list the gesture prerequisite')
  assert.equal(
    gesture.state,
    'unknown',
    'the save cannot see gestures, so this must not be claimed either way',
  )
  assert.ok(gesture.ifMissing, 'an unverifiable prerequisite must say what happens without it')
}

// --- medium confidence carries a warning ------------------------------------
{
  const r = await allPlaces(NO_COVENANTS)
  for (const g of r.matches) {
    if (g.confidence === 'medium') {
      assert.ok(
        g.warnings.some((w) => /单一来源/.test(w)),
        `${g.id} is medium confidence but carries no warning`,
      )
    }
  }
}

// --- every source id resolves to a real URL ---------------------------------
{
  const r = await allPlaces(NO_COVENANTS)
  for (const g of r.matches) {
    assert.ok(g.sources.length > 0, `${g.id} has no resolved source`)
    for (const s of g.sources) {
      assert.match(s.url, /^https?:\/\//, `${g.id} source ${s.id} has no usable URL`)
    }
  }
}

// --- a miss when the library has nothing says so, and points elsewhere -------
{
  const r = await findPlaces('完全不存在的东西xyz', NO_COVENANTS)
  assert.equal(r.matches.length, 0)
  assert.ok(/ds3_sources/.test(r.hint ?? ''), 'a miss must redirect to the citation tool')
}

// --- similar-sounding names must not outrank the exact one ------------------
// 青之守护者 and 吞噬神明的守护人 share the bigram 守护, so a naive scorer tied
// them and asking about one surfaced the other first.
{
  for (const [q, want] of [
    ['青之守护者', '青之守护者'],
    ['吞噬神明的守护人', '吞噬神明的守护人'],
    ['青教', '青教'],
  ]) {
    const r = await findPlaces(q, NO_COVENANTS)
    assert.ok(r.matches.length > 0, `no match for ${q}`)
    assert.equal(
      r.matches[0].name.zh,
      want,
      `query "${q}" ranked "${r.matches[0].name.zh}" first`,
    )
  }
}

// --- every covenant achievement is covered by a guide -----------------------
// Each of ACH17..ACH24 should have a place, or the panel silently stops
// offering a route for it.
{
  const r = await allPlaces(NO_COVENANTS)
  const have = new Set(r.matches.map((g) => g.achievement?.api).filter(Boolean))
  const want = ['ACH17', 'ACH18', 'ACH19', 'ACH20', 'ACH21', 'ACH22', 'ACH23', 'ACH24']
  for (const api of want) {
    assert.ok(have.has(api), `no place guide covers covenant achievement ${api}`)
  }
}

console.log('ok: place guides are three-part, and never guess an unverifiable prerequisite')

/**
 * The First Flame is an ending record, not a bonfire.
 *
 * It lives in the game's bonfire table, so a cleared character shows it as
 * unlit forever. The client once filtered it in one place and not the other,
 * and clicking 无火祭祀场 asked "how do I reach The First Flame" — a bonfire
 * that does not exist.
 *
 * These assertions pin the separation at the source, where the Host splits
 * real gaps from ending markers.
 *
 * NOTE ON STATE: an earlier version asserted `'无火祭祀场' in missingByArea` is
 * false, which held only for a character who had finished a playthrough. After
 * entering NG+ the game resets bonfire flags, so that area legitimately has
 * real unlit bonfires again and the assertion failed — not a regression, a test
 * that had hardcoded one save's state. The invariant that always holds is the
 * one below: the marker is never reported as a missing bonfire.
 */
import assert from 'node:assert/strict'
import { overview } from '../src/state/overview.js'

const o = await overview('plankton')

assert.ok(Array.isArray(o.endingMarkers), 'endingMarkers missing')

// The invariant: an ending marker is never offered as a bonfire to go and light.
for (const [area, list] of Object.entries(o.missingByArea)) {
  for (const label of list) {
    assert.ok(
      !/First Flame/i.test(label),
      `area "${area}" still lists the ending marker as a missing bonfire`,
    )
  }
}

// If the save has any unlit flag in that area, the leftovers must be real
// bonfires — the marker itself must never be among them.
if ('无火祭祀场' in o.missingByArea) {
  const list = o.missingByArea['无火祭祀场']
  assert.ok(list.length > 0, 'an area listed as a gap must actually list something')
  assert.ok(
    list.every((l) => !/First Flame/i.test(l)),
    `无火祭祀场 lists only the ending marker: ${JSON.stringify(list)}`,
  )
}

// The marker, when present, is reported as a marker.
for (const m of o.endingMarkers) {
  assert.ok(typeof m === 'string' && m.length > 0, 'ending marker must be a label')
  const inGaps = Object.values(o.missingByArea).some((list) =>
    list.some((l) => l === m),
  )
  assert.ok(!inGaps, `ending marker "${m}" also appears as a bonfire gap`)
}

console.log('ok: ending markers are separated from bonfire gaps')

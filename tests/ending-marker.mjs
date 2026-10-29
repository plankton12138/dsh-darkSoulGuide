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
 */
import assert from 'node:assert/strict'
import { overview } from '../src/state/overview.js'

const o = await overview('plankton')

assert.ok(Array.isArray(o.endingMarkers), 'endingMarkers missing')
assert.ok(o.endingMarkers.length > 0, 'expected at least one ending marker on a cleared save')
assert.ok(
  o.endingMarkers.some((m) => /First Flame/.test(m)),
  `expected The First Flame among markers, got ${JSON.stringify(o.endingMarkers)}`,
)

// No area gap may contain an ending marker.
for (const [area, list] of Object.entries(o.missingByArea)) {
  for (const label of list) {
    assert.ok(
      !/First Flame/i.test(label),
      `area "${area}" still lists the ending marker as a missing bonfire`,
    )
  }
}

// The area that holds only the marker must not appear as a gap at all.
assert.ok(
  !('无火祭祀场' in o.missingByArea),
  '无火祭祀场 appears as a gap although its only unlit flag is the ending marker',
)

console.log('ok: ending markers are separated from bonfire gaps')

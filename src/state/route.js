/**
 * Area routing over the DS3 connectivity graph.
 *
 * The graph is data (data/reference/ds3/routes.json), not code; edges are
 * treated as walkable in both directions and their `requires` notes are only
 * surfaced as caveats, never used to prune the search.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROUTES = path.resolve(HERE, '..', '..', 'data', 'reference', 'ds3', 'routes.json')

let cached = null

export function loadRoutes() {
  if (cached) return cached
  cached = JSON.parse(readFileSync(ROUTES, 'utf8'))
  return cached
}

/** Undirected adjacency: node -> [{ to, note, requires, confidence }] */
function buildAdjacency(edges) {
  const adj = new Map()
  const push = (a, b, e, forward) => {
    if (!adj.has(a)) adj.set(a, [])
    adj.get(a).push({
      to: b,
      note: e.note,
      requires: e.requires,
      confidence: e.confidence ?? 'high',
      forward,
    })
  }
  for (const e of edges) {
    push(e.from, e.to, e, true)
    push(e.to, e.from, e, false)
  }
  return adj
}

function bfs(start, adj) {
  const dist = new Map([[start, 0]])
  const prev = new Map()
  const via = new Map()
  const queue = [start]
  while (queue.length) {
    const node = queue.shift()
    for (const edge of adj.get(node) ?? []) {
      if (dist.has(edge.to)) continue
      dist.set(edge.to, dist.get(node) + 1)
      prev.set(edge.to, node)
      via.set(edge.to, edge)
      queue.push(edge.to)
    }
  }
  return { dist, prev, via }
}

function tracePath(start, target, prev, via) {
  const nodes = [target]
  const edges = []
  let cur = target
  while (cur !== start) {
    const p = prev.get(cur)
    if (p === undefined) return null
    edges.unshift(via.get(cur))
    nodes.unshift(p)
    cur = p
  }
  return { nodes, edges }
}

/**
 * Visit order for `targets` starting at `from`.
 *
 * With few targets (the normal case) the order is chosen by exhaustive search
 * over permutations using all-pairs hop distances; greedy nearest-first can be
 * badly wrong because it may strand the player far from a later target. Beyond
 * 8 targets it falls back to greedy.
 */
/**
 * Visit order for `targets` starting at `from`.
 *
 * `litAreas` changes what "distance" means. Bonfires are warp points, so once an
 * area has one lit, travel to it is a menu selection, not a walk. Without this
 * the planner reported "5 hops" routes across a cleared world, which reads as
 * five areas of walking and is simply wrong.
 *
 * With warping available, the useful cost is not hops: it is how much extra
 * walking a detour costs inside one trip. We keep the connectivity path for
 * areas that are still unlit (you cannot warp to a bonfire you have never
 * reached), and mark everything else as a direct warp.
 */
export function planRoute({ from, targets, routes = loadRoutes(), litAreas = null }) {
  const adj = buildAdjacency(routes.edges)
  const known = new Set(adj.keys())
  const unknownFrom = known.has(from) ? null : from
  const wanted = targets.filter((t) => t !== from)
  const unreachableUnknown = wanted.filter((t) => !known.has(t))
  const pool = wanted.filter((t) => known.has(t))
  const start = known.has(from) ? from : routes.start || [...known][0]

  if (!pool.length) {
    return { from: start, stops: [], unreachable: unreachableUnknown }
  }

  const warp = litAreas ? new Set(litAreas) : new Set()
  const canWarp = (area) => warp.has(area)

  const searches = new Map()
  for (const node of [start, ...pool]) searches.set(node, bfs(node, adj))

  const hops = (a, b) => {
    const d = searches.get(a)?.dist.get(b)
    return d === undefined ? Infinity : d
  }

  // Targets reachable by warp cost the same as each other; only the areas you
  // must actually walk to keep their hop cost. Sorting by cost then groups the
  // warpable ones together instead of pretending there is an optimal path
  // between menu entries.
  const order = pool.length <= 8 ? bestPermutation(start, pool, hops) : greedyOrder(start, pool, hops)
  const unreachable = [...order.unreachable, ...unreachableUnknown]

  const stops = []
  let cursor = start
  for (const area of order.visit) {
    const search = searches.get(cursor) ?? bfs(cursor, adj)
    const path = tracePath(cursor, area, search.prev, search.via)
    // A lit bonfire is a warp point: you select it from the menu, you do not
    // walk the connectivity path. Reporting hops without this flag is what made
    // a cleared character look like it needed five areas of walking.
    const byWarp = canWarp(area)
    stops.push({
      area,
      transport: byWarp ? 'warp' : 'walk',
      hops: byWarp ? 0 : hops(cursor, area),
      path: byWarp ? [area] : path ? path.nodes : [],
      requires: byWarp
        ? []
        : path
          ? [...new Set(path.edges.filter((e) => e.forward).map((e) => e.requires).filter(Boolean))]
          : [],
      uncertain: byWarp
        ? []
        : path
          ? [...new Set(path.edges.filter((e) => e.forward && e.confidence !== 'high').map((e) => e.note))]
          : [],
    })
    cursor = area
  }

  return {
    from: start,
    stops,
    unreachable,
    ...(litAreas ? { warpsAvailable: warp.size } : {}),
    ...(unknownFrom ? { note: `起点「${unknownFrom}」不在连通图里，改从「${start}」计算` } : {}),
  }
}

function bestPermutation(start, pool, hops) {
  const n = pool.length
  const reachable = pool.filter((t) => hops(start, t) < Infinity)
  const unreachable = pool.filter((t) => hops(start, t) === Infinity)
  if (reachable.length !== n) {
    // Some targets are cut off from the start; optimise over what is reachable.
    if (!reachable.length) return { visit: [], unreachable }
    return { ...bestPermutation(start, reachable, hops), unreachable }
  }

  let best = null
  let bestCost = Infinity
  const used = new Array(n).fill(false)
  const current = []

  const walk = (depth, cost) => {
    if (cost >= bestCost) return
    if (depth === n) {
      bestCost = cost
      best = current.slice()
      return
    }
    let prev = depth === 0 ? start : current[depth - 1]
    for (let i = 0; i < n; i += 1) {
      if (used[i]) continue
      const step = hops(prev, pool[i])
      if (step === Infinity) continue
      used[i] = true
      current.push(pool[i])
      walk(depth + 1, cost + step)
      current.pop()
      used[i] = false
    }
  }
  walk(0, 0)
  return { visit: best ?? [], unreachable }
}

function greedyOrder(start, pool, hops) {
  const visit = []
  const left = pool.slice()
  const unreachable = []
  let cursor = start
  let guard = 0
  while (left.length && guard++ < 64) {
    const reachable = left.filter((t) => hops(cursor, t) < Infinity)
    if (!reachable.length) {
      unreachable.push(...left)
      break
    }
    reachable.sort((a, b) => hops(cursor, a) - hops(cursor, b))
    const next = reachable[0]
    visit.push(next)
    left.splice(left.indexOf(next), 1)
    cursor = next
  }
  return { visit, unreachable }
}

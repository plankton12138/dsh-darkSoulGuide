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
export function planRoute({ from, targets, routes = loadRoutes() }) {
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

  const searches = new Map()
  for (const node of [start, ...pool]) searches.set(node, bfs(node, adj))

  const hops = (a, b) => {
    const d = searches.get(a)?.dist.get(b)
    return d === undefined ? Infinity : d
  }

  const order = pool.length <= 8 ? bestPermutation(start, pool, hops) : greedyOrder(start, pool, hops)
  const unreachable = [...order.unreachable, ...unreachableUnknown]

  const stops = []
  let cursor = start
  for (const area of order.visit) {
    const search = searches.get(cursor) ?? bfs(cursor, adj)
    const path = tracePath(cursor, area, search.prev, search.via)
    stops.push({
      area,
      hops: hops(cursor, area),
      path: path ? path.nodes : [],
      requires: path
        ? [...new Set(path.edges.filter((e) => e.forward).map((e) => e.requires).filter(Boolean))]
        : [],
      uncertain: path
        ? [...new Set(path.edges.filter((e) => e.forward && e.confidence !== 'high').map((e) => e.note))]
        : [],
    })
    cursor = area
  }

  return {
    from: start,
    stops,
    unreachable,
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

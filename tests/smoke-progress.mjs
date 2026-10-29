/**
 * Smoke test: the panel route must answer with non-empty JSON.
 *
 * This exists because the same bug shipped twice: when `webServer` was not
 * reachable from the plugin scope, registration was skipped silently and the
 * route returned 404 with an EMPTY body, which the client reported as
 * "Unexpected end of JSON input" — a message that points at JSON parsing and
 * hides the real cause.
 *
 * Usage (with the desktop app running):
 *   node tests/smoke-progress.mjs http://127.0.0.1:54523
 */
const base = process.argv[2] || 'http://127.0.0.1:62770'
const url = `${base}/darksouls-guide/progress`

let res
try {
  res = await fetch(url)
} catch (err) {
  console.error(`FAIL: cannot reach ${url} — ${err.message}`)
  console.error('Is the DSH desktop app running? Pass its URL as the first argument.')
  process.exit(1)
}

if (res.status === 404) {
  console.error(`FAIL: 404 from ${url}`)
  console.error('The route is not registered. Check that index.js registers it through')
  console.error("ctx.inject(['webServer'], ...) — an undeclared service is skipped silently.")
  process.exit(1)
}

const text = await res.text()
if (!text.trim()) {
  console.error(`FAIL: empty body from ${url} (client would report "Unexpected end of JSON input")`)
  process.exit(1)
}

let data
try {
  data = JSON.parse(text)
} catch (err) {
  console.error(`FAIL: body is not JSON — ${err.message}`)
  console.error(text.slice(0, 200))
  process.exit(1)
}

if (!data.ok) {
  console.error(`FAIL: route answered ok=false — ${data.reason}`)
  process.exit(1)
}

for (const key of ['character', 'areas', 'edges', 'achievements']) {
  if (!(key in data)) {
    console.error(`FAIL: payload missing "${key}"`)
    process.exit(1)
  }
}

const areaCount = Object.keys(data.areas).length
const achCount = data.achievements.entries.length
console.log(`ok: ${data.character.name} Lv${data.character.level} | ${areaCount} areas | ${achCount} achievements | ${text.length} bytes`)

if (areaCount !== 19) {
  console.error(`WARN: expected 19 areas, got ${areaCount}`)
  process.exitCode = 1
}

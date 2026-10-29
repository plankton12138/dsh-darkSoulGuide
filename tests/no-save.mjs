/**
 * Failure-path test: with no save file, buildProgress must return a structured
 * reason plus a hint, not throw.
 *
 * This is the first screen a new user sees after installing from the public
 * repository, and "读不到存档" with no next step is a dead end.
 */
process.env.APPDATA = 'C:\\__no_such_appdata__'
const { buildProgress } = await import('../src/panel/progress.js')

const d = await buildProgress()

const checks = []
const check = (name, ok) => { checks.push({ name, ok }); if (!ok) console.error(`FAIL: ${name}`) }

check('does not throw', true)
check('ok is false', d.ok === false)
check('has reason', typeof d.reason === 'string' && d.reason.length > 0)
check('has hint', typeof d.hint === 'string' && d.hint.length > 0)
check('code is no_save', d.code === 'no_save')
check('hint names the expected path', /DarkSoulsIII/.test(d.hint || ''))

console.log(`reason: ${d.reason}`)
console.log(`hint:   ${d.hint}`)
console.log(checks.every((c) => c.ok) ? 'ok: failure path is actionable' : 'FAILED')
process.exit(checks.every((c) => c.ok) ? 0 : 1)

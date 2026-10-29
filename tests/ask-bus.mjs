import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const src = readFileSync('client.js', 'utf8')
const start = src.indexOf("    const BUS = 'darksouls-guide:ask'")
const end = src.indexOf('    // ------------------------------------------------------------------\n    // Asking the guide from a click.')
assert.ok(start > 0 && end > start, 'bus block not found in client.js')
const busCode = src.slice(start, end)

const makeBus = () =>
  new Function('window', `${busCode}; return { publishAsk, takeAsk, onAsk, fillDraft }`)({
    dispatchEvent: () => {},
  })

// --- 1. a published question reaches the listener and lands in the draft ---
{
  const bus = makeBus()
  let draft = ''
  let rev = 0
  const inputActions = {
    captureInsertion: () => ({ draftRev: rev, start: draft.length, end: draft.length }),
    insertText: (text, span) => {
      if (span.draftRev !== rev) return false
      draft = draft.slice(0, span.start) + text + draft.slice(span.end)
      return true
    },
    setDraft: (text) => { draft = text; return true },
  }

  let got = null
  bus.onAsk((a) => {
    got = a
    if (a?.text) bus.fillDraft(inputActions, a.text)
  })

  bus.publishAsk('伊鲁席尔还剩 2 个篝火没点，具体怎么走？')
  assert.ok(got, 'listener did not receive the question')
  assert.equal(got.text, '伊鲁席尔还剩 2 个篝火没点，具体怎么走？')
  assert.equal(draft, '伊鲁席尔还剩 2 个篝火没点，具体怎么走？', 'draft was not filled')

  // --- 2. a second question appends, it does not replace what is there ---
  bus.publishAsk('那第二个问题呢？')
  assert.equal(
    draft,
    '伊鲁席尔还剩 2 个篝火没点，具体怎么走？那第二个问题呢？',
    'the second question must append to the existing draft',
  )
}

// --- 3. a stale revision falls back to setDraft instead of losing the text ---
{
  const bus = makeBus()
  let draft = '玩家自己写了一半'
  let rev = 0
  const inputActions = {
    // Simulates the editor refusing an insertion at a stale revision.
    captureInsertion: () => ({ draftRev: rev - 1, start: draft.length, end: draft.length }),
    insertText: () => false,
    setDraft: (text) => { draft = text; return true },
  }
  bus.onAsk((a) => { if (a?.text) bus.fillDraft(inputActions, a.text) })
  bus.publishAsk('问题')
  assert.equal(draft, '问题', 'setDraft fallback did not run')
}

// --- 4. a question published before any listener is still takeable ---
{
  const bus = makeBus()
  bus.publishAsk('early question')
  const taken = bus.takeAsk()
  assert.ok(taken && taken.text === 'early question', 'pending question was lost')
  assert.equal(bus.takeAsk(), null, 'takeAsk did not consume')
}

console.log('ok: bus delivers questions to the draft')

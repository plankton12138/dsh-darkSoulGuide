/**
 * Client-side actions: turn a click into a question the guide answers.
 *
 * Two mechanisms, chosen by what the slot can reach:
 *
 *   - `inputActions` (composer slot only) inserts text into the draft. This is
 *     the *preferred* path: the player sees the question before sending it and
 *     can edit it. The main panel slot does not receive `inputActions`, so it
 *     cannot use this.
 *   - `sessions` + `ISession.prompt()` sends a message outright. Works from any
 *     slot, but skips the draft, so it is only used where inserting is not
 *     available or where the player explicitly asked to send.
 *
 * Actions never guess: if neither path is available the button reports itself as
 * unavailable rather than appearing to work and doing nothing.
 */

/** Ask the guide a question from a surface without a draft. */
export async function askInSession(sessions, sessionId, text) {
  if (!sessions || !sessionId) return { ok: false, reason: 'no_session' }
  let reference
  try {
    reference = sessions.retain(sessionId, { source: 'controllerOperation' })
    const binding = await reference.ready
    const result = await binding.session.prompt([{ type: 'text', text }], 'queue')
    return result?.ok ? { ok: true } : { ok: false, reason: result?.error?.message ?? 'rejected' }
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) }
  } finally {
    try {
      reference?.release()
    } catch {
      /* already released */
    }
  }
}

/**
 * Insert into the composer draft when possible, otherwise send.
 *
 * Returns which path ran so the caller can show honest feedback.
 */
export async function ask(inputActions, sessions, sessionId, text) {
  if (inputActions?.insertText) {
    try {
      const span = inputActions.captureInsertion?.()
      if (span && inputActions.insertText(text, span)) return { ok: true, via: 'draft' }
    } catch {
      /* fall through to send */
    }
  }
  if (inputActions?.setDraft) {
    try {
      inputActions.setDraft(text)
      return { ok: true, via: 'draft' }
    } catch {
      /* fall through to send */
    }
  }
  const r = await askInSession(sessions, sessionId, text)
  return r.ok ? { ok: true, via: 'sent' } : r
}

/** Prebuilt questions, kept in one place so both surfaces offer the same set. */
export const ASKS = {
  next: '我现在该去哪儿？',
  missing: '我全收集的话还缺什么？按能补的数量排一下。',
  build: '按我现在的属性和装备，怎么调整比较好？',
  level: '我接下来该往哪个方向加点？',
  souls: '我包里还有哪些 Boss 灵魂没换？分别能换什么？',
  gems: '我还缺哪些质变宝石？分别在哪里拿？',
  covenant: '我要拿全教团奖励，每个还要交多少个、去哪里刷？',
  bonfire: '我还有几个篝火没点，分别怎么去？',
}

/** A question about one specific missing item, with its name filled in. */
export function askAboutItem(name, kind) {
  const what = kind === 'ring' ? '戒指' : kind === 'spell' ? '法术' : '物品'
  return `「${name}」这个${what}在哪里拿？如果存档看不出位置，请给出处链接。`
}

/** A question about one area's remaining bonfires. */
export function askAboutArea(area, missing) {
  const list = missing
    .map((l) => l.split(' - ').slice(1).join(' - '))
    .filter(Boolean)
    .join('、')
  return `${area} 还剩 ${missing.length} 个篝火没点（${list}），具体怎么走？`
}

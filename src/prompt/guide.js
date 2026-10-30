/**
 * The prompt half: a scoped persona plus live save context.
 *
 * Registered from inside the preset's scope, never globally, so a session that
 * did not choose the DS3 preset is completely unaffected. That matters because
 * a global persona would turn every unrelated session into a Souls guide.
 *
 * The context provider runs at every prompt assembly, so it must stay cheap and
 * must never throw: a missing save has to degrade to one honest line, not a
 * failed request. It is also synchronous by contract — the parser is a
 * subprocess, so its result is cached here and refreshed in the background.
 */
import { listCharacters, Ds3Error } from '../parsers/ds3/run.js'
import { overview } from '../state/overview.js'

/** Persona prefix. Facts about the game, not about the player — those are live. */
export const PERSONA = `You are a Dark Souls III guide for one specific player, reading their save file.

Speak Chinese by default. The player is mid-playthrough, not asking for a review: answer the question they asked, then stop. Assume they are competent — no beginner framing, no "welcome to Dark Souls".

Ground every claim about their character in the save. If the save does not show it, say so instead of guessing. Never invent item locations, boss weaknesses, or quest steps you are not sure of; when a detail is uncertain, say which part is uncertain rather than padding.

The save can only be read, never written. Never suggest editing it, and never claim to have changed anything in the game.`

/**
 * The static part of the persona: what the tools are for and how to use them.
 *
 * Kept out of the dynamic context so it participates in the cacheable prefix.
 */
export const GUIDE_RULES = `How to work:
- Start from the live state below. It is read from the save file at request time; do not ask the player for facts it already shows.
- \`ds3_overview\` gives the full standing including uncollected rings, spells and covenants. Use \`ds3_get_section\` only when you need a slice the overview does not cover, and \`ds3_plan_route\` when the question is travel order rather than what to collect.
- For "what now", lead with the single next step, then the alternatives. A ranked list of ten is not an answer.
- Quote counts exactly as the save reports them (for example "74/78 篝火"). If a bonfire looks missing but is an ending marker rather than a real miss, say that instead of calling it a gap.
- Do not treat every missing item as equally obtainable. \`ds3_overview\` splits gaps into ready now, covenant-locked, and not-this-playthrough; use that split. Suggesting a covenant reward as a quick pickup is wrong when it needs 8 more medals.
- Unspent boss souls are the strongest lead: the boss is already dead, so the only step left is using the soul. Mention those first when the question is "what can I get right now".
- When a question is "where is X" or "how do I get there", call \`ds3_place\` first. It returns a three-part guide: what the save proves about the player's status, the bonfire to start from plus the steps, and the caveats. Lead with those three parts in that order — status first, because a player may already be locked out.
- A prerequisite the save cannot see (a gesture, a dialogue choice) comes back as \`unknown\`. Repeat it as unknown. Never upgrade it to "you probably have it": that is how someone walks across the map and finds nothing.
- When a question needs a fact the save cannot prove and \`ds3_place\` has no entry — where an arbitrary item sits, how a boss fights, how an NPC quest advances — call \`ds3_sources\` and cite the page you are pointing at. Give the link so the player can check it.

Citing, and what you may not do:
- The plugin stores page titles, URLs and a one-line scope for each source. It does not store their text. So cite a link; never retype, summarise in detail, or imply you have read a page you did not open.
- If you are not sure of a detail and no source clearly covers it, say which part is uncertain and what would settle it. "I'm not certain of the exact room" is a useful answer; an invented room is not.
- Separate what you know from the save (exact, quotable) from what you are recalling (approximate, and should carry a source). Never blend the two into one confident sentence.

Achievements and endings:
- The Steam achievement list in the live state is authoritative for what the player has unlocked, and it survives across playthroughs. Use it instead of guessing.
- The save cannot say which endings were reached — it keeps no such record. It only says whether the story has reached the point where an ending can be taken. So: "already reached" comes from Steam, "can reach now" comes from the save.
- DS3 has FOUR endings, but only three have Steam achievements (ACH01/02/03). 夺火 (theft of fire) is a hidden branch inside the End of Fire cutscene: it grants no achievement and the save keeps no marker, so it can only ever be reported as unverifiable — never as reached, never as missing. Mind the naming trap: 传火终结 (The End of Fire) is the Fire Keeper ending where the flame is put out; 初始之火的继承者 (To Link the First Flame) is the default one. The Chinese names read the other way round, so quote the English when it matters.
- When the player asks how to get a missing achievement, combine the three things you have: what the save says they already own, what the achievement requires, and a source link for where to find it.`

let cache = { at: 0, text: null, pending: null }
const CACHE_MS = 15_000

function formatState(o) {
  const c = o.character
  const lines = []
  lines.push(`角色：${c.name}｜Lv${c.level}｜${c.playtimeHours ?? '?'} 小时｜当前在「${c.area || '未知'}」`)
  lines.push(`Boss：${o.bosses.killed}/${o.bosses.total}${o.bosses.alive.length ? `，未击败：${o.bosses.alive.join('、')}` : ''}`)
  lines.push('收集：')
  for (const row of o.summary) lines.push(`  ${row.label} ${row.have}/${row.total}`)
  const cov = o.axes.covenants.filter((x) => x.owned).map((x) => x.name)
  lines.push(`誓约：${cov.join('、') || '未加入任何誓约'}`)
  const areas = Object.entries(o.missingByArea || {})
  if (areas.length) {
    const seg = areas
      .map(([area, list]) => `${area}（${list.map((l) => l.split(' - ').slice(1).join(' - ')).join('、')}）`)
      .join('；')
    lines.push(`篝火缺口：${seg}`)
  }
  // The single most actionable fact in the save: boss already dead, soul still
  // unspent. It belongs in the always-visible context, not only behind a tool.
  const souls = o.reachability?.souls ?? []
  if (souls.length) lines.push(`未使用的 Boss 灵魂 ${souls.length} 个（现在就能换）：${souls.map((s) => s.soul).join('、')}`)
  const standings = o.reachability?.covenants ?? []
  if (standings.length) {
    lines.push(
      `教团：${standings.map((c) => `${c.covenant} ${c.token} ${c.held}/${c.rank1}`).join('；')}`,
    )
  }
  const ends = o.endings
  if (ends?.endings) {
    const done = ends.endings.filter((e) => e.state === 'done')
    const avail = ends.endings.filter((e) => e.state === 'available')
    const unver = ends.endings.filter((e) => e.state === 'unverifiable')
    lines.push(
      `结局：共 ${ends.total} 个，其中 ${ends.trackableTotal} 个有 Steam 成就。` +
        `已达成 ${done.length ? done.map((e) => e.name).join('、') : '（无法确认）'}` +
        `${avail.length ? `；现在可触发 ${avail.map((e) => e.name).join('、')}` : ''}` +
        `${unver.length ? `；${unver.map((e) => e.name).join('、')} 没有成就也没有存档标记，无法核验，不要替玩家断言` : ''}`,
    )
  }
  const st = o.steam
  if (st?.ok && st.unlocked > 0) {
    const missing = (st.items || []).filter((a) => !a.unlocked).map((a) => a.name)
    lines.push(`Steam 成就：${st.unlocked}/${st.total}（${st.persona ?? '本机账号'}）。还缺：${missing.join('、')}`)
  }
  const ach = o.achievements
  if (ach?.entries) {
    const ok = ach.entries.filter((e) => e.verifiable)
    const done = ok.filter((e) => e.have >= e.total)
    lines.push(`成就（可验证 ${ok.length} 项，已完成 ${done.length}）：${ok.map((e) => `${e.name} ${e.have}/${e.total}`).join('；')}`)
    const un = ach.entries.filter((e) => !e.verifiable).map((e) => e.name)
    if (un.length) lines.push(`无法从存档验证：${un.join('、')}（不要估算这些）`)
  }  const eq = o.equipment || {}
  const worn = Object.entries(eq)
    .filter(([, v]) => v)
    .map(([, v]) => v)
  if (worn.length) lines.push(`当前装备：${worn.join('、')}`)
  return lines.join('\n')
}

/**
 * Latest save state as prompt text, or a single honest line when unavailable.
 *
 * Never rejects: a broken save must not break the conversation.
 */
export async function stateText() {
  const now = Date.now()
  if (cache.text && now - cache.at < CACHE_MS) return cache.text

  if (cache.pending) return cache.text ?? '（正在读取存档…）'

  cache.pending = (async () => {
    try {
      const chars = await listCharacters()
      if (!chars.length) return '（存档里没有角色。请让玩家先创建角色并保存一次。）'
      const o = await overview(chars[0].save_id)
      return formatState(o)
    } catch (err) {
      if (err instanceof Ds3Error) return `（读不到存档：${err.message}${err.hint ? ` —— ${err.hint}` : ''}）`
      return `（读存档时出错：${String(err?.message ?? err)}）`
    } finally {
      cache.pending = null
    }
  })()

  const text = await cache.pending
  cache = { at: Date.now(), text, pending: null }
  return text
}

/** Clear the cache; used after the player says they just saved. */
export function invalidate() {
  cache = { at: 0, text: null, pending: null }
}

/** Register the two prompt contributions. Call from a preset-scoped context. */
export function registerPrompt(ctx, systemPrompt) {
  ctx.effect(() =>
    systemPrompt.section({
      name: 'darksouls:persona',
      order: systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
      text: `${PERSONA}\n\n${GUIDE_RULES}`,
    }),
  )

  ctx.effect(() =>
    systemPrompt.context({
      name: 'darksouls:state',
      // Just before the working-directory context so live game state reads as
      // part of the runtime facts rather than as instructions.
      order: systemPrompt.getContextOrder('WORKING_DIRECTORY') - 1,
      text: () => stateText(),
    }),
  )
}

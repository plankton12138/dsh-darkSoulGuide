/**
 * Citation index: where to send the player for facts the save cannot prove.
 *
 * This is deliberately a link table, not a knowledge base. The game's own text
 * sits behind encrypted BHD indexes (all eight measure 8.00/8.0 entropy), so
 * item locations and NPC scripts cannot be read locally. Two candidate public
 * sources were checked, and both forbid what a knowledge base would need:
 *
 *   - huijiwiki: its 人机协议 requires written permission for bulk automated
 *     access and states that content obtained for AI use is not covered by any
 *     CC licence. Scraping it would breach that.
 *   - ali213: pages carry an all-rights-reserved notice. robots.txt allows the
 *     paths, but permission to crawl is not permission to republish.
 *
 * So the plugin ships titles, URLs and a one-line scope for each source, and the
 * model cites them instead of paraphrasing. This is the "give a source when
 * uncertain" requirement, implemented in the only form that is lawful.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FILE = path.resolve(HERE, '..', '..', 'data', 'reference', 'ds3', 'sources.json')

let cached = null

async function load() {
  if (cached) return cached
  cached = JSON.parse(await readFile(FILE, 'utf8'))
  return cached
}

/**
 * Match a free-text topic against each source's `use_for` tags.
 *
 * Splitting on whitespace alone fails for Chinese: "誓约奖励" is one token and
 * never matches a tag reading "誓约等级奖励". So a query term also counts as a
 * hit when either side contains the other, and for CJK the query is additionally
 * cut into character bigrams, which is enough to match short tags without a
 * tokenizer.
 */
function terms(topic) {
  const raw = String(topic ?? '')
    .toLowerCase()
    .split(/[\s,，、。？?!/]+/)
    .filter(Boolean)
  const out = new Set(raw)
  for (const t of raw) {
    if (!/[\u4e00-\u9fff]/.test(t)) continue
    for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2))
  }
  return [...out]
}

function score(source, list) {
  const fields = [source.title, source.covers, ...(source.use_for ?? [])].join(' ').toLowerCase()
  let n = 0
  for (const t of list) {
    if (!t) continue
    if (fields.includes(t) || t.includes(source.covers ?? '\u0000')) n += 1
  }
  return n
}

export async function findSources(topic) {
  const doc = await load()
  const list = terms(topic)

  const ranked = doc.sources
    .map((s) => ({ source: s, score: list.length ? score(s, list) : 1 }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)

  return {
    topic: topic ?? '',
    matches: ranked.map((r) => r.source),
    // Returned with every response so the model always has the boundary in view.
    policy: doc._policy,
    licensing: doc._licensing,
  }
}

export function registerSourcesTool(ctx) {
  ctx.effect(() =>
    ctx.tools.register({
      name: 'ds3_sources',
      description:
        "Find where to verify something the save cannot prove, such as an item's location, a boss strategy, or an NPC quest step. Returns page titles and URLs to cite. The plugin does not store these pages' text, so cite the link and let the player read it rather than paraphrasing a page you have not opened.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          topic: {
            type: 'string',
            description: 'What you need a source for, e.g. "戒指位置", "boss 打法", "誓约奖励", "NPC 支线".',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            topic: { type: 'string' },
            matches: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  url: { type: 'string' },
                  covers: { type: 'string' },
                  caveat: { type: 'string' },
                },
              },
            },
            policy: { type: 'object', additionalProperties: true },
            licensing: { type: 'object', additionalProperties: true },
          },
        },
        render: (_args, v) => {
          if (!v.matches.length) {
            return [{ type: 'text', text: `没找到与「${v.topic}」对应的出处。` }]
          }
          const lines = [`「${v.topic || '全部'}」相关出处：`]
          for (const s of v.matches.slice(0, 6)) {
            lines.push(`- ${s.title}：${s.url}`)
            lines.push(`  覆盖：${s.covers}`)
            if (s.caveat) lines.push(`  注意：${s.caveat}`)
          }
          lines.push('这些页面正文未收录，请引用链接让玩家自行核对，不要转述未读过的内容。')
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args) {
        return findSources(args?.topic)
      },
    }),
  )
}

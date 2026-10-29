/**
 * Host entry for the Dark Souls III guide.
 *
 * This module is mounted twice with different config:
 *   - the profile row (panel only) serves the sidebar map route;
 *   - the 「黑魂3 攻略」preset row (tools + prompt) scopes the model-facing
 *     half to sessions that chose that preset.
 * Mounting it once globally would put four DS3 tools and a Souls persona in
 * every unrelated coding session, so the split is what keeps that containment.
 */
import { registerTools } from './src/tools/ds3.js'
import { registerOverviewTool } from './src/tools/overview.js'
import { invalidate, registerPrompt } from './src/prompt/guide.js'
import { buildProgress } from './src/panel/progress.js'

export const name = 'darksouls-guide'

// `tools` is required: every configuration registers something model-facing.
// `webServer` and `systemPrompt` are read with ctx.get() instead, because the
// preset scope may not expose them and a hard dependency would leave the row
// pending forever.
export const inject = ['tools']

const ROUTE = '/darksouls-guide/progress'

function send(res, body) {
  const payload = JSON.stringify(body)
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function registerPanel(ctx) {
  const webServer = ctx.get('webServer')
  if (!webServer || typeof webServer.register !== 'function') return

  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: async (req, res) => {
        try {
          if (req.url?.includes('fresh=1')) invalidate()
          send(res, await buildProgress())
        } catch (err) {
          send(res, { ok: false, reason: String(err?.message ?? err) })
        }
      },
    }),
  )
}

export function apply(ctx, config = {}) {
  // Defaults are the preset half; the profile row opts out explicitly.
  const wantTools = config.tools !== false
  const wantPrompt = config.prompt !== false
  const wantPanel = config.panel === true

  if (wantPanel) registerPanel(ctx)

  if (wantTools) {
    registerTools(ctx)
    registerOverviewTool(ctx)
  }

  if (wantPrompt) {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt && typeof systemPrompt.context === 'function') {
      registerPrompt(ctx, systemPrompt)
    } else {
      // A preset scope without the registry is a composition error worth
      // seeing in the log rather than silently losing the guide's grounding.
      ctx.logger?.warn?.('darksouls-guide: systemPrompt unavailable, live save context not registered')
    }
  }
}

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
import { registerSourcesTool } from './src/tools/sources.js'
import { registerPlacesTool } from './src/tools/places.js'
import { invalidate, registerPrompt } from './src/prompt/guide.js'
import { buildProgress } from './src/panel/progress.js'

export const name = 'darksouls-guide'

// `tools` is the only hard dependency: both mounts register tools, and it is
// present in every scope this module loads into.
//
// `webServer` is deliberately NOT listed here, and this was a real bug: with it
// undeclared, `ctx.get('webServer')` returned undefined without any error, the
// route registration was skipped silently, and the panel got a 404 with an empty
// body — surfacing in the UI as "Unexpected end of JSON input". Listing it as a
// hard dependency is not the fix either: the preset row mounts inside an agent
// scope that does not provide webServer, so that row would sit pending forever
// and the tools would never register.
//
// The correct mechanism is a runtime optional injection (see registerPanel):
// Cordis calls back when the service is available and disposes with the scope.
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

/**
 * Register the progress route when `webServer` exists in this scope.
 *
 * `ctx.inject(deps, callback)` is Cordis's runtime optional injection: unlike
 * the static `inject` export it does not gate activation, it fires when the
 * service becomes available and unwinds with the scope. That is exactly the
 * semantics needed here, because this module loads into two scopes and only one
 * of them has an HTTP server.
 */
function registerPanel(ctx) {
  ctx.inject(['webServer'], (scope) => {
    const webServer = scope.webServer
    if (!webServer || typeof webServer.register !== 'function') return

    return webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: async (req, res) => {
        try {
          if (req.url?.includes('fresh=1')) invalidate()
          send(res, await buildProgress())
        } catch (err) {
          // Always answer with valid JSON: an empty body is what made the panel
          // show "Unexpected end of JSON input" instead of the real reason.
          send(res, { ok: false, reason: String(err?.message ?? err) })
        }
      },
    })
  })
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
    registerSourcesTool(ctx)
    registerPlacesTool(ctx)
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

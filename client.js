window.__ModuleLoader__.load({
  id: 'dsh-darksouls-guide',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useRef } = React

    // ------------------------------------------------------------------
    // A one-line bus between surfaces that cannot see each other's props.
    //
    // `inputActions` — the only thing that can put text into the composer — is
    // provided to composer slots, while the progress map lives in a `main` slot
    // that has no access to it. The slots share no context, so a click in the
    // map cannot reach the draft by props alone. A window CustomEvent is used
    // rather than a guessed service because it is the one cross-surface
    // mechanism that is certainly present in the browser.
    //
    // The bus carries a question, never an answer: a surface publishes "the
    // user wants to ask X", and the composer-side helper fills the draft.
    // ------------------------------------------------------------------

    const BUS = 'darksouls-guide:ask'
    const busListeners = new Set()
    let busPending = null

    function publishAsk(text) {
      if (!text) return false
      busPending = { text, at: Date.now() }
      for (const fn of busListeners) {
        try {
          fn(busPending)
        } catch {
          /* one bad listener must not break the others */
        }
      }
      try {
        window.dispatchEvent(new CustomEvent(BUS, { detail: busPending }))
      } catch {
        /* the direct listeners above already covered it */
      }
      return busListeners.size > 0
    }

    function takeAsk() {
      const p = busPending
      busPending = null
      return p
    }

    function onAsk(fn) {
      busListeners.add(fn)
      return () => busListeners.delete(fn)
    }

    /**
     * Put a question into the composer draft.
     *
     * `insertText` is an undoable insertion at the caret and is refused when the
     * draft changed underneath it, in which case `setDraft` is the fallback.
     * The draft is only filled, never submitted.
     */
    function fillDraft(inputActions, text) {
      if (!inputActions) return false
      try {
        const span = inputActions.captureInsertion?.()
        if (span && inputActions.insertText?.(text, span)) return true
      } catch {
        /* fall through */
      }
      try {
        inputActions.setDraft?.(text)
        return true
      } catch {
        return false
      }
    }

    // ------------------------------------------------------------------
    // Asking the guide from a click.
    //
    // The panel slot does NOT receive `inputActions` (only composer slots do),
    // so a click in the map cannot reach the draft by props alone. The two
    // surfaces are bridged by a small bus (src/client/bus.js): the map
    // publishes a question, and the composer-side helper puts it in the draft.
    //
    // The draft is filled, never submitted. The player sees the question and
    // sends it themselves, which keeps every answer under their control and
    // avoids spending a turn on a click they did not mean to make.
    // ------------------------------------------------------------------

    const ASKS = {
      next: '我现在该去哪儿？',
      missing: '我全收集的话还缺什么？按能补的数量排一下。',
      build: '按我现在的属性和装备，怎么调整比较好？',
      level: '我接下来该往哪个方向加点？',
      souls: '我包里还有哪些 Boss 灵魂没换？分别能换什么？',
      gems: '我还缺哪些质变宝石？分别在哪里拿？',
      covenant: '我要拿全教团奖励，每个还要交多少个、去哪里刷？',
      bonfire: '我还有几个篝火没点，分别怎么去？',
    }

    function askAboutItem(name, kind) {
      const what = kind === 'ring' ? '戒指' : kind === 'spell' ? '法术' : '物品'
      return `「${name}」这个${what}在哪里拿？如果存档看不出位置，请给出处链接。`
    }

    function askAboutArea(area, missing) {
      const list = missing
        .map((l) => l.split(' - ').slice(1).join(' - '))
        .filter(Boolean)
        .join('、')
      return `${area} 还剩 ${missing.length} 个篝火没点（${list}），具体怎么走？`
    }

    /**
     * A button that drops a question into the composer draft.
     *
     * It reports what happened rather than assuming success: if nothing is
     * listening the button says so, instead of appearing to work and doing
     * nothing.
     */
    function AskButton({ text, label, compact }) {
      const [state, setState] = useState('idle')
      const click = () => {
        if (state === 'busy') return
        setState('busy')
        const delivered = publishAsk(text)
        setState(delivered ? 'sent' : 'error')
        if (delivered) setTimeout(() => setState('idle'), 1500)
        else setTimeout(() => setState('idle'), 2600)
      }
      const tone =
        state === 'sent' ? C.done : state === 'error' ? C.warn : state === 'busy' ? C.sub : C.text
      return h(
        'button',
        {
          onClick: click,
          disabled: state === 'busy',
          title: text,
          style: {
            fontSize: compact ? 10 : 11,
            lineHeight: 1.4,
            padding: compact ? '1px 6px' : '2px 8px',
            borderRadius: 999,
            cursor: state === 'busy' ? 'wait' : 'pointer',
            border: `1px solid ${state === 'error' ? C.warn : C.border}`,
            background: 'transparent',
            color: tone,
            whiteSpace: 'nowrap',
          },
        },
        state === 'sent' ? '已填入' : state === 'busy' ? '…' : state === 'error' ? '无处可放' : label,
      )
    }

    // Area keys must match the labels the Host emits from bonfires.json. That
    // table folds Filianore's Rest into 环印城 and has no 初始之火 area, so those
    // two are not drawn as separate nodes.
    const GROUPS = [
      { title: '洛斯里克', areas: ['洛斯里克高墙', '洛斯里克城', '大书库', '无火祭祀场'] },
      { title: '不死聚落周边', areas: ['不死聚落', '深邃教堂', '牺牲之路', '法兰要塞'] },
      { title: '地底', areas: ['卡萨斯地下墓地', '烟熏湖', '伊鲁席尔地下监狱', '罪业之都'] },
      { title: '冷冽谷', areas: ['伊鲁席尔', '古龙顶端'] },
      { title: '始终之地', areas: ['灰烬墓地', '传火祭祀场'] },
      { title: 'DLC', areas: ['艾雷德尔绘画世界', '聚集地', '环印城'] },
    ]

    // [column, row] in the layout grid. This is a progression sketch, not a
    // map: no coordinate data for areas exists in the save file.
    const NODES = {
      灰烬墓地: [0, 0],
      传火祭祀场: [0, 1],
      洛斯里克高墙: [0, 2],
      不死聚落: [0, 3],
      牺牲之路: [1, 3],
      法兰要塞: [1, 4],
      深邃教堂: [0, 4],
      卡萨斯地下墓地: [2, 4],
      烟熏湖: [2, 3],
      伊鲁席尔: [3, 4],
      伊鲁席尔地下监狱: [3, 3],
      罪业之都: [3, 2],
      古龙顶端: [4, 4],
      洛斯里克城: [1, 2],
      大书库: [1, 1],
      无火祭祀场: [1, 0],
      艾雷德尔绘画世界: [2, 0],
      聚集地: [3, 0],
      环印城: [4, 0],
    }

    const EDGES = [
      ['灰烬墓地', '传火祭祀场'], ['传火祭祀场', '洛斯里克高墙'],
      ['洛斯里克高墙', '不死聚落'], ['不死聚落', '牺牲之路'],
      ['牺牲之路', '法兰要塞'], ['牺牲之路', '深邃教堂'],
      ['法兰要塞', '卡萨斯地下墓地'], ['卡萨斯地下墓地', '烟熏湖'],
      ['卡萨斯地下墓地', '伊鲁席尔'], ['伊鲁席尔', '伊鲁席尔地下监狱'],
      ['伊鲁席尔地下监狱', '罪业之都'], ['伊鲁席尔地下监狱', '古龙顶端'],
      ['伊鲁席尔', '洛斯里克城'], ['洛斯里克城', '大书库'],
      ['大书库', '无火祭祀场'], ['深邃教堂', '艾雷德尔绘画世界'],
      ['无火祭祀场', '聚集地'], ['聚集地', '环印城'],
    ]

    const COLS = 5
    const ROWS = 5
    const CELL_W = 108
    const CELL_H = 46
    const GAP_X = 14
    const GAP_Y = 16
    const PAD = 12

    const W = PAD * 2 + COLS * CELL_W + (COLS - 1) * GAP_X
    const H = PAD * 2 + ROWS * CELL_H + (ROWS - 1) * GAP_Y

    const C = {
      border: 'var(--dsw-alias-border-2, #3a3a3a)',
      text: 'var(--dsw-alias-label-primary, #e6e6e6)',
      sub: 'var(--dsw-alias-label-secondary, #9a9a9a)',
      done: 'var(--dsw-alias-brand-primary, #d97f36)',
      idle: 'var(--dsw-alias-bg-layer-2, #262626)',
      curr: 'var(--dsw-alias-state-success-primary, #6cc070)',
      warn: 'var(--dsw-alias-state-warning-primary, #d9a136)',
    }

    function box(name) {
      const p = NODES[name]
      if (!p) return null
      const [cx, cy] = p
      const x = PAD + cx * (CELL_W + GAP_X)
      const y = PAD + cy * (CELL_H + GAP_Y)
      return { x, y, cx: x + CELL_W / 2, cy: y + CELL_H / 2 }
    }

    // Shared across every surface: the map and the strip must never disagree.
    // A module-level cache keeps a second consumer from re-fetching on mount.
    let shared = { loading: true }
    const listeners = new Set()

    function publish(next) {
      shared = next
      for (const fn of listeners) fn(next)
    }

    function useProgress(pollMs = 60000) {
      const [state, setState] = useState(shared)
      useEffect(() => {
        listeners.add(setState)
        setState(shared)
        let alive = true
        const load = () => {
          fetch('/darksouls-guide/progress')
            .then((r) => r.json())
            .then((d) => alive && publish({ loading: false, data: d }))
            .catch((e) => alive && publish({ loading: false, error: String(e) }))
        }
        if (shared.loading) load()
        const t = setInterval(load, pollMs)
        return () => {
          alive = false
          listeners.delete(setState)
          clearInterval(t)
        }
      }, [pollMs])
      return state
    }

    function MapCanvas({ d }) {
      const [hover, setHover] = useState(null)
      // Per-node click feedback. Held here rather than inside the map callback
      // because hooks cannot be declared inside a loop or a map callback.
      const [nodeStatus, setNodeStatus] = useState({})
      const cur = d.character.area

      const lines = EDGES.map(([a, b], i) => {
        const A = box(a)
        const B = box(b)
        if (!A || !B) return null
        const lit = d.areas[a] && d.areas[a].total > 0 && d.areas[a].lit === d.areas[a].total &&
          d.areas[b] && d.areas[b].total > 0 && d.areas[b].lit === d.areas[b].total
        return h('line', {
          key: i,
          x1: A.cx, y1: A.cy, x2: B.cx, y2: B.cy,
          stroke: lit ? C.done : C.border,
          strokeWidth: lit ? 1.6 : 1,
          opacity: lit ? 0.55 : 0.85,
        })
      })

      const nodes = Object.keys(NODES).map((name) => {
        const b = box(name)
        const a = d.areas[name]
        if (!b) return null
        const has = a && a.total > 0
        const full = has && a.lit === a.total
        const isCur = cur === name
        const on = hover === name
        // A node with bonfires still unlit is actionable: clicking asks how to
        // reach them. Nodes that are done or have no data stay inert so the map
        // does not offer clicks that lead nowhere.
        // The Host already separated real bonfires from ending markers, so
        // this list cannot contain a marker that has no bonfire to reach.
        const missing = (d.missingByArea || {})[name] || []
        const clickable = missing.length > 0
        const status = nodeStatus[name] || 'idle'
        const onClick = () => {
          if (!clickable || status === 'busy') return
          setNodeStatus((s) => ({ ...s, [name]: 'busy' }))
          const delivered = publishAsk(askAboutArea(name, missing))
          setNodeStatus((s) => ({ ...s, [name]: delivered ? 'sent' : 'error' }))
          setTimeout(
            () => setNodeStatus((s) => ({ ...s, [name]: 'idle' })),
            delivered ? 1500 : 2600,
          )
        }
        return h(
          'g',
          {
            key: name,
            onMouseEnter: () => setHover(name),
            onMouseLeave: () => setHover(null),
            onClick,
            style: { cursor: clickable ? 'pointer' : 'default' },
          },
          h('rect', {
            x: b.x, y: b.y, width: CELL_W, height: CELL_H, rx: 7,
            fill: C.idle,
            stroke: isCur ? C.curr : full ? C.done : C.border,
            strokeWidth: isCur ? 2 : 1,
            opacity: on ? 1 : 0.96,
          }),
          has
            ? h('rect', {
                x: b.x, y: b.y, width: (CELL_W * a.lit) / a.total, height: CELL_H, rx: 7,
                fill: C.done, opacity: 0.16,
              })
            : null,
          h('text', {
            x: b.x + 7, y: b.y + 18,
            fill: C.text, fontSize: 11, fontWeight: 500,
          }, name.length > 8 ? name.slice(0, 8) : name),
          h('text', {
            x: b.x + 7, y: b.y + 33,
            fill: full ? C.done : C.sub, fontSize: 10,
          }, has ? `${a.lit}/${a.total}` : '无数据'),
          isCur
            ? h('circle', { cx: b.x + CELL_W - 10, cy: b.y + 11, r: 4, fill: C.curr })
            : null,
          // Click feedback drawn on the node itself, so the player sees which
          // area the question was about.
          status !== 'idle'
            ? h('circle', {
                cx: b.x + CELL_W - 10,
                cy: b.y + CELL_H - 11,
                r: 4,
                fill: status === 'sent' ? C.done : status === 'error' ? C.warn : C.sub,
              })
            : null,
        )
      })

      const tip = hover && d.areas[hover]
        ? h(
            'div',
            {
              style: {
                position: 'absolute', left: 8, bottom: 8,
                background: 'var(--dsw-alias-bg-layer-1, #1b1b1b)',
                border: `1px solid ${C.border}`, borderRadius: 6,
                padding: '3px 8px', fontSize: 10, color: C.sub, pointerEvents: 'none',
              },
            },
            `${hover}：${d.areas[hover].lit}/${d.areas[hover].total} 篝火` +
              (d.areas[hover].lit === d.areas[hover].total
                ? '，已满'
                : `，还差 ${d.areas[hover].total - d.areas[hover].lit}`) +
              ((d.missingByArea || {})[hover]?.length ? '　点击提问怎么走' : ''),
          )
        : null

      return h(
        'div',
        { style: { position: 'relative', width: '100%', overflowX: 'auto' } },
        h(
          'svg',
          { viewBox: `0 0 ${W} ${H}`, style: { width: '100%', maxWidth: W * 1.5, display: 'block' } },
          h('g', null, lines),
          h('g', null, nodes),
        ),
        tip,
      )
    }

    /** A single progress axis: label, count, and a thin bar. */
    function Axis({ row }) {
      const pct = row.total ? Math.round((row.have / row.total) * 100) : 0
      const full = row.have >= row.total && row.total > 0
      return h(
        'div',
        { style: { minWidth: 92, flex: '0 0 auto' } },
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 11, color: C.sub } },
          h('span', null, row.label),
          h('span', { style: { color: full ? C.done : C.text, fontVariantNumeric: 'tabular-nums' } },
            `${row.have}/${row.total}`),
        ),
        h(
          'div',
          {
            style: {
              height: 3, borderRadius: 2, marginTop: 3,
              background: 'var(--dsw-alias-bg-layer-3, #333)',
              overflow: 'hidden',
            },
          },
          h('div', { style: { width: `${pct}%`, height: '100%', background: full ? C.done : C.warn } }),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Shared blocks.
    //
    // These live above both surfaces because the main panel and the right-pane
    // tab must show the same thing — the first version inlined them in the page
    // only, so the right tab silently lacked "next step" and "achievements"
    // while looking complete. One component per block prevents that drift.
    // ---------------------------------------------------------------------

    /**
     * Save-read failure, with the next step rather than just the symptom.
     *
     * Anyone installing this from the public repository starts without a save
     * file, so this is the first screen most new users see. "读不到存档" alone
     * is a dead end; the hint is what turns it into something actionable.
     */
    function SaveError({ d, error, compact }) {
      const reason = d?.reason || error || '未知原因'
      const hint = d?.hint || null
      const code = d?.code || null
      const pad = compact ? 16 : 24
      const size = compact ? 12 : 13
      return h(
        'div',
        { style: { padding: pad, color: C.sub, fontSize: size, lineHeight: 1.8, fontFamily: 'inherit' } },
        h('div', { style: { color: C.warn, marginBottom: 6 } }, `读不到存档：${reason}`),
        hint ? h('div', null, hint) : null,
        code === 'no_save'
          ? h(
              'div',
              { style: { marginTop: 8, opacity: 0.85 } },
              '装好插件但还没进过游戏？先创建角色并保存一次，再刷新这里。',
            )
          : null,
        code === 'python_missing'
          ? h(
              'div',
              { style: { marginTop: 8, opacity: 0.85 } },
              '解析器需要本机的 Python 3。装好后重开应用。',
            )
          : null,
        code === 'dependency_missing'
          ? h(
              'div',
              { style: { marginTop: 8, opacity: 0.85 } },
              '需要 cryptography：在终端执行 pip install cryptography。',
            )
          : null,
      )
    }

    const RANK_STYLE = {
      now: { label: '现在就能做', color: C.curr },
      grind: { label: '需要刷', color: C.warn },
      later: { label: '可以慢慢来', color: C.sub },
      note: { label: '说明', color: C.sub },
    }

    /**
     * Endings: the condition, and what the save says about it.
     *
     * Each row states its own evidence. Two of the four endings leave no
     * readable mark in the save, so they are shown as "unverifiable" rather than
     * counted — a completion count here would be a guess.
     */
    function EndingList({ d }) {
      const e = d.endings
      if (!e?.endings) return null
      const MARK = {
        done: { icon: '✔', color: C.done, label: '已达成' },
        available: { icon: '○', color: C.curr, label: '现在可拿' },
        possible: { icon: '?', color: C.warn, label: '存档看不出' },
        locked: { icon: '·', color: C.sub, label: '未解锁' },
        ambiguous: { icon: '?', color: C.warn, label: '无法区分' },
      }
      return h(
        'div',
        { style: { marginTop: 16 } },
        h('div', { style: { fontSize: 12, color: C.text, marginBottom: 6, fontWeight: 600 } }, '结局'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          e.endings.map((x) => {
            const m = MARK[x.state] || MARK.possible
            return h(
              'div',
              {
                key: x.id,
                style: {
                  border: `1px solid ${C.border}`, borderRadius: 6,
                  padding: '6px 10px', borderLeft: `3px solid ${m.color}`,
                },
              },
              h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                h('span', { style: { color: m.color, fontSize: 12 } }, m.icon),
                h('span', { style: { fontSize: 12, color: C.text, flex: 1 } }, x.name),
                h('span', { style: { fontSize: 10, color: m.color, whiteSpace: 'nowrap' } }, m.label),
              ),
              h('div', { style: { fontSize: 11, color: C.sub, marginTop: 2 } }, x.condition),
              h('div', { style: { fontSize: 10, color: C.sub, marginTop: 2, opacity: 0.85 } }, x.evidence),
            )
          }),
          e.precedence && e.precedence.length
            ? h(
                'div',
                { style: { fontSize: 10, color: C.sub, marginTop: 4, lineHeight: 1.6 } },
                e.precedence.join(' '),
              )
            : null,
        ),
      )
    }

    /** A row of one-click questions, for the things players ask most. */
    function QuickAsks() {
      const items = [
        { label: '下一步干嘛', ask: ASKS.next },
        { label: '还缺什么', ask: ASKS.missing },
        { label: '配装建议', ask: ASKS.build },
        { label: '加点', ask: ASKS.level },
        { label: '灵魂怎么用', ask: ASKS.souls },
        { label: '缺哪些宝石', ask: ASKS.gems },
        { label: '教团还差多少', ask: ASKS.covenant },
      ]
      return h(
        'div',
        {
          style: {
            display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14,
          },
        },
        items.map((it) => h(AskButton, { key: it.label, text: it.ask, label: it.label })),
      )
    }

    /** "What to do next", ordered by how soon it can be acted on. */
    function NextSteps({ d }) {
      const steps = nextSteps(d)
      return h(
        'div',
        { style: { marginTop: 14 } },
        h('div', { style: { fontSize: 12, color: C.text, marginBottom: 6, fontWeight: 600 } }, '下一步'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          steps.length === 0
            ? h('div', { style: { fontSize: 12, color: C.done } }, '所有轴都已满，可以进 NG+ 了。')
            : steps.map((s, i) => {
                const rank = RANK_STYLE[s.rank] || RANK_STYLE.later
                return h(
                  'div',
                  {
                    key: i,
                    style: {
                      border: `1px solid ${C.border}`, borderRadius: 6,
                      padding: '6px 10px',
                      opacity: s.rank === 'note' ? 0.7 : 1,
                      borderLeft: `3px solid ${rank.color}`,
                    },
                  },
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                    h('span', { style: { fontSize: 12, color: C.text, flex: 1 } }, s.title),
                    s.ask
                      ? h(AskButton, { text: s.ask, label: '问 AI', compact: true })
                      : null,
                    h('span', { style: { fontSize: 10, color: rank.color, whiteSpace: 'nowrap' } }, rank.label),
                  ),
                  h('div', { style: { fontSize: 11, color: C.sub, marginTop: 2 } }, s.detail),
                  (s.items || []).length
                    ? h(
                        'div',
                        { style: { fontSize: 10, color: C.sub, marginTop: 3, lineHeight: 1.6 } },
                        s.items.join('、') + (s.more ? ` 等 ${s.items.length + s.more} 个` : ''),
                      )
                    : null,
                )
              }),
        ),
      )
    }

    /**
     * Achievements: bars for verifiable entries, a stated reason for the rest.
     *
     * A fake progress bar is worse than an honest "cannot be read from the
     * save", so unverifiable entries never get a percentage.
     */
    function AchievementList({ d }) {
      const ach = d.achievements
      if (!ach?.entries) return null
      // Which achievement is currently being asked about, so the missing-item
      // list can expand under it instead of opening somewhere else.
      const [openId, setOpenId] = useState(null)
      return h(
        'div',
        { style: { marginTop: 16 } },
        h('div', { style: { fontSize: 12, color: C.text, marginBottom: 6, fontWeight: 600 } }, '成就'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
          ach.entries
            .filter((e) => e.verifiable)
            .map((e) =>
              h(
                'div',
                { key: e.id, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                  h(
                    'span',
                    { style: { width: 14, fontSize: 11, color: e.have >= e.total ? C.done : C.sub } },
                    e.have >= e.total ? '✔' : '·',
                  ),
                  h('span', { style: { fontSize: 11, color: C.text, flex: 1 } }, e.name),
                  e.missing && e.missing.length
                    ? h(
                        'button',
                        {
                          onClick: () => setOpenId(openId === e.id ? null : e.id),
                          title: `还差 ${e.missing.length} 项，点开逐个问`,
                          style: {
                            fontSize: 10, padding: '1px 6px', borderRadius: 999,
                            cursor: 'pointer', border: `1px solid ${C.border}`,
                            background: 'transparent', color: C.sub, whiteSpace: 'nowrap',
                          },
                        },
                        openId === e.id ? '收起' : `缺 ${e.missing.length}`,
                      )
                    : null,
                  h('span', {
                    style: {
                      fontSize: 11, color: e.have >= e.total ? C.done : C.sub,
                      fontVariantNumeric: 'tabular-nums',
                    },
                  }, `${e.have}/${e.total}`),
                ),
                openId === e.id && e.missing && e.missing.length
                  ? h(
                      'div',
                      {
                        style: {
                          display: 'flex', flexWrap: 'wrap', gap: 4,
                          paddingLeft: 22, marginTop: 1,
                        },
                      },
                      e.missing.slice(0, 24).map((name) =>
                        h(AskButton, {
                          key: name,
                          text: askAboutItem(
                            name,
                            e.group === 'ring' ? 'ring' : e.group === 'spell' ? 'spell' : 'item',
                          ),
                          label: name,
                          compact: true,
                        }),
                      ),
                      e.missing.length > 24
                        ? h(
                            'span',
                            { style: { fontSize: 10, color: C.sub, alignSelf: 'center' } },
                            `…另有 ${e.missing.length - 24} 个`,
                          )
                        : null,
                    )
                  : null,
              ),
            ),
          ach.entries
            .filter((e) => !e.verifiable)
            .map((e) =>
              h(
                'div',
                {
                  key: e.id,
                  title: e.reason,
                  style: { display: 'flex', gap: 8, fontSize: 10, color: C.sub, opacity: 0.65 },
                },
                h('span', { style: { width: 14 } }, '—'),
                h('span', { style: { flex: 1 } }, e.name),
                h('span', null, '存档读不出'),
              ),
            ),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Composer pill: a single compact control in the composer tool row.
    //
    // This used to be a full-width strip below the composer, which cost a
    // permanent row of vertical space in every session. The same information
    // now lives behind one button: the row height is unchanged, and the
    // detail only appears when asked for.
    // ---------------------------------------------------------------------

    const CHIPS = [
      { label: '下一步干嘛', ask: '我现在该去哪儿？' },
      { label: '还缺什么', ask: '我全收集的话还缺什么？按能补的数量排一下。' },
      { label: '配装建议', ask: '按我现在的属性和装备，怎么调整比较好？' },
      { label: '加点', ask: '我接下来该往哪个方向加点？' },
    ]

    /**
     * The listener that actually fills the draft.
     *
     * It is a separate component on purpose: the pill itself returns null when
     * the save cannot be read, and a component that returns null unmounts its
     * effects — which would silently drop every question published while the
     * game was mid-save. This component never returns null, so the
     * subscription survives.
     */
    function DraftListener({ inputActions }) {
      useEffect(() => {
        const off = onAsk((ask) => {
          if (!ask?.text) return
          fillDraft(inputActions, ask.text)
        })
        // A question published before this mounted is still worth taking.
        const pending = takeAsk()
        if (pending?.text) fillDraft(inputActions, pending.text)
        return off
      }, [inputActions])
      return null
    }

    function Pill({ inputActions }) {
      const st = useProgress(60000)
      const d = st.data
      const [open, setOpen] = useState(false)
      const [flash, setFlash] = useState(null)
      const wrap = useRef(null)

      // Close on an outside click, the way every other popup in the app does.
      useEffect(() => {
        if (!open) return
        const onDown = (e) => {
          if (wrap.current && !wrap.current.contains(e.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [open])

      // Unreadable save: stay out of the composer entirely rather than
      // occupying the tool row of every session with an error.
      if (!d || !d.ok) return null

      const c = d.character
      const left = (d.summary || []).filter((r) => r.have < r.total)
      const label = `Lv${c.level} · ${c.area || '未知'}`

      const ask = (text) => {
        // insertText is an undoable insertion at the caret; setDraft would
        // throw away whatever the player already typed.
        try {
          const span = inputActions?.captureInsertion?.()
          const done = span && inputActions?.insertText ? inputActions.insertText(text, span) : false
          if (!done) inputActions?.setDraft?.(text)
          setFlash(text)
        } catch {
          setFlash(null)
        }
        setOpen(false)
      }

      const row = (key, label2, value, pct, full) =>
        h(
          'div',
          { key, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 } },
          h('span', { style: { color: C.sub, width: 34, flex: '0 0 auto' } }, label2),
          h(
            'div',
            {
              style: {
                flex: 1, height: 3, borderRadius: 2,
                background: 'var(--dsw-alias-bg-layer-3, #333)', overflow: 'hidden',
              },
            },
            h('div', { style: { width: `${pct}%`, height: '100%', background: full ? C.done : C.warn } }),
          ),
          h('span', { style: { color: full ? C.done : C.text, fontVariantNumeric: 'tabular-nums' } }, value),
        )

      return h(
        'div',
        { ref: wrap, style: { position: 'relative', display: 'inline-flex' } },
        h(
          'button',
          {
            onClick: () => setOpen((v) => !v),
            title: '黑魂3 进度与快捷提问',
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 11, lineHeight: 1.4, padding: '2px 8px', height: 22,
              borderRadius: 999, cursor: 'pointer',
              border: `1px solid ${open ? C.curr : C.border}`,
              background: 'transparent',
              color: open ? C.curr : C.sub,
              whiteSpace: 'nowrap',
            },
          },
          h(Icon, { size: 11 }),
          label,
        ),
        open
          ? h(
              'div',
              {
                style: {
                  position: 'absolute', bottom: 28, left: 0, zIndex: 40,
                  width: 236, padding: 10,
                  border: `1px solid ${C.border}`, borderRadius: 8,
                  background: 'var(--dsw-alias-bg-layer-1, #1b1b1b)',
                  boxShadow: '0 6px 24px rgba(0,0,0,.45)',
                  display: 'flex', flexDirection: 'column', gap: 7,
                },
              },
              h(
                'div',
                { style: { display: 'flex', justifyContent: 'space-between', fontSize: 11 } },
                h('span', { style: { color: C.text, fontWeight: 600 } }, c.name),
                h('span', { style: { color: C.sub } }, `Boss ${d.bosses.killed}/${d.bosses.total}`),
              ),
              (d.summary || []).map((r) =>
                row(
                  r.key,
                  r.label,
                  `${r.have}/${r.total}`,
                  r.total ? Math.round((r.have / r.total) * 100) : 0,
                  r.have >= r.total && r.total > 0,
                ),
              ),
              left.length
                ? h('div', { style: { fontSize: 10, color: C.warn } }, `还有 ${left.length} 项未满`)
                : h('div', { style: { fontSize: 10, color: C.done } }, '全部收集完成'),
              h('div', { style: { height: 1, background: C.border, margin: '2px 0' } }),
              h(
                'div',
                { style: { display: 'flex', flexWrap: 'wrap', gap: 5 } },
                CHIPS.map((chip) =>
                  h(
                    'button',
                    {
                      key: chip.label,
                      onClick: () => ask(chip.ask),
                      title: chip.ask,
                      style: {
                        fontSize: 10, lineHeight: 1.4, padding: '2px 7px',
                        borderRadius: 999, cursor: 'pointer',
                        border: `1px solid ${C.border}`,
                        background: flash === chip.ask ? C.done : 'transparent',
                        color: flash === chip.ask ? '#111' : C.text,
                        whiteSpace: 'nowrap',
                      },
                    },
                    chip.label,
                  ),
                ),
              ),
            )
          : null,
      )
    }

    // ---------------------------------------------------------------------
    // Main panel page
    // ---------------------------------------------------------------------

    /**
     * What to suggest next.
     *
     * Ordered by how soon it can actually be acted on, not by which number is
     * biggest: an unspent boss soul takes one trip to the kiln, while a
     * covenant spell may need eight more medals. Those are not the same kind of
     * task, so they are not shown in the same list.
     */
    function nextSteps(d) {
      const out = []
      const r = d.reachability || {}

      // 1. Boss souls: boss already dead, soul still unspent.
      if ((r.souls || []).length) {
        out.push({
          rank: 'now',
          title: `${r.souls.length} 个 Boss 灵魂还没换`,
          detail: '已击败，灵魂仍在包里 —— 去任意的灵魂交换处就能各换一件。',
          items: r.souls.slice(0, 8).map((s) => s.soul),
          more: Math.max(0, r.souls.length - 8),
          ask: ASKS.souls,
        })
      }

      // 2. Bonfires: concrete, located, one trip each.
      const byArea = d.missingByArea || {}
      for (const [area, list] of Object.entries(byArea)) {
        const real = list
        if (!real.length) continue
        out.push({
          rank: 'now',
          title: `${area}：${real.length} 个篝火未点`,
          detail: real.map((l) => l.split(' - ').slice(1).join(' - ')).join('、'),
          ask: askAboutArea(area, real),
        })
      }
      // Ending markers are reported, never counted as a missing bonfire: the
      // Host separates them from the gaps, so nothing here has to re-check.
      for (const marker of d.endingMarkers || []) {
        out.push({
          rank: 'note',
          title: `结局标记：${marker.split(' - ').slice(1).join(' - ')}`,
          detail: '这是结局分支的记录，不是漏掉的篝火 —— 只在你选择点燃初始之火时才会变化。',
        })
      }

      // 3. Covenant work: shows the exact remaining count so "grind" is not vague.
      if ((r.covenants || []).length) {
        for (const c of r.covenants) {
          if (c.toRank1 <= 0) continue
          out.push({
            rank: 'grind',
            title: `${c.covenant}：还差 ${c.toRank1} 个 ${c.token}`,
            detail: `当前 ${c.held}/${c.rank1}，交满可换该教团奖励。`,
            ask: ASKS.covenant,
          })
        }
      }
      if ((r.gaps?.covenantGaps || []).length) {
        out.push({
          rank: 'grind',
          title: `${r.gaps.covenantGaps.length} 个法术锁在教团等级里`,
          detail: r.gaps.covenantGaps.map((g) => g.name).join('、'),
          ask: ASKS.covenant,
        })
      }

      // 4. Plain pickups, counted rather than listed — the list is too long to
      //    be readable and the model answers item-level questions better.
      if ((r.gaps?.now || []).length) {
        const rings = r.gaps.now.filter((g) => g.kind === 'ring').length
        const spells = r.gaps.now.filter((g) => g.kind === 'spell').length
        out.push({
          rank: 'later',
          title: `本轮可补 ${r.gaps.now.length} 项`,
          detail: `戒指 ${rings}、法术 ${spells}。具体哪一件可以问我。`,
          ask: ASKS.missing,
        })
      }

      return out
    }

    function Page() {
      const st = useProgress(60000)
      const d = st.data

      const head = h(
        'div',
        { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 } },
        h('div', { style: { fontSize: 15, fontWeight: 600, color: C.text } }, '黑暗之魂 3 · 进度图'),
        d && d.ok
          ? h(
              'div',
              { style: { fontSize: 12, color: C.sub } },
              `${d.character.name} Lv${d.character.level}｜Boss ${d.bosses.killed}/${d.bosses.total}｜${d.character.playtimeHours} 小时`,
            )
          : null,
      )

      if (st.loading) return h('div', { style: { padding: 24, color: C.sub } }, '读取存档…')
      if (!d || !d.ok) return h(SaveError, { d, error: st.error })

      const axes = h(
        'div',
        {
          style: {
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
            gap: 10, marginBottom: 14,
          },
        },
        (d.summary || []).map((row) => h(Axis, { key: row.key, row })),
      )

      const legend = h(
        'div',
        { style: { display: 'flex', gap: 14, fontSize: 11, color: C.sub, marginTop: 10, flexWrap: 'wrap' } },
        h('span', null, '■ 橙边＝篝火全满'),
        h('span', null, '● 绿点＝当前位置'),
        h('span', null, '连线＝区域连通'),
      )

      const hint = h(
        'div',
        { style: { fontSize: 11, color: C.sub, marginTop: 12, lineHeight: 1.7 } },
        '想要具体建议就去对话里问 —— 输入框上方的药丸有快捷提问。',
      )

      return h(
        'div',
        {
          style: {
            padding: '18px 22px',
            height: '100%',
            overflowY: 'auto',
            fontFamily: 'inherit',
            boxSizing: 'border-box',
          },
        },
        head,
        h(QuickAsks, {}),
        axes,
        h(MapCanvas, { d }),
        legend,
        h(NextSteps, { d }),
        h(EndingList, { d }),
        h(AchievementList, { d }),
        hint,
      )
    }

    // 16px glyph for the sidebar rail.
    function Icon({ size }) {
      const s = typeof size === 'number' ? size : 16
      return h(
        'svg',
        { width: s, height: s, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('circle', { cx: 8, cy: 8, r: 6.4, stroke: 'currentColor', strokeWidth: 1.4, opacity: 0.85 }),
        h('path', { d: 'M8 4.2c1.6 1.9 2.5 2.9 2.5 4.4a2.5 2.5 0 0 1-5 0c0-.9.55-1.6 1.2-2.2.2.9.5 1.3 1.1 1.6-.06-1.3-.18-2.4.2-3.8z', fill: 'currentColor' }),
      )
    }

    const NS = 'darksouls-guide'

    /** Right-pane body: the same map, sized for a narrow column. */
    function PaneBody() {
      // Never genuinely blank: a thrown render leaves an empty pane with no
      // explanation, which is exactly the symptom this seat had before.
      try {
        return h(PaneInner, null)
      } catch (err) {
        return h(
          'div',
          { style: { padding: 16, color: C.sub, fontSize: 12 } },
          `面板渲染失败：${String(err?.message ?? err)}`,
        )
      }
    }

    function PaneInner() {
      const st = useProgress(60000)
      const d = st.data
      if (st.loading) return h('div', { style: { padding: 16, color: C.sub, fontSize: 12 } }, '读取存档…')
      if (!d || !d.ok) return h(SaveError, { d, error: st.error, compact: true })
      const left = (d.summary || []).filter((r) => r.have < r.total)
      return h(
        'div',
        { style: { padding: 12, overflowY: 'auto', height: '100%', boxSizing: 'border-box' } },
        h(
          'div',
          { style: { fontSize: 11, color: C.sub, marginBottom: 10, lineHeight: 1.7 } },
          h('span', { style: { color: C.text } }, `${d.character.name} Lv${d.character.level}`),
          h('span', { style: { color: C.curr } }, `｜${d.character.area || '未知'}`),
          h('br'),
          `Boss ${d.bosses.killed}/${d.bosses.total}｜${d.character.playtimeHours} 小时`,
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 } },
          (d.summary || []).map((row) =>
            h(Axis, { key: row.key, row }),
          ),
        ),
        h(MapCanvas, { d }),
        left.length
          ? h('div', { style: { fontSize: 11, color: C.warn, marginTop: 10 } }, `还有 ${left.length} 项未满`)
          : h('div', { style: { fontSize: 11, color: C.done, marginTop: 10 } }, '全部收集完成'),
        // Same blocks as the main panel. The first version stopped at the map,
        // so the tab looked finished while the two most actionable sections were
        // missing.
        h(QuickAsks, {}),
        h(NextSteps, { d }),
        h(EndingList, { d }),
        h(AchievementList, { d }),
      )
    }

    function TabTitle() {
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
        h(Icon, { size: 12 }),
        '黑魂3',
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: NS }, (props) => h(Page, props)),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: NS, order: 30, label: () => '黑魂3 进度' },
            (props) => h(Icon, props),
          ),
        )
        // One compact pill in the composer tool row. It must not add a row of
        // its own: a full-width strip below the composer cost permanent
        // vertical space, so the detail lives in a popup instead.
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            { name: 'conversation.input.left', id: NS, order: 20 },
            (props) =>
              h(
                React.Fragment,
                null,
                // The listener has to exist even when the pill hides itself, so
                // it is registered as a sibling rather than inside the pill.
                h(DraftListener, { inputActions: props.inputActions }),
                h(Pill, { inputActions: props.inputActions }),
              ),
          ),
        )

        // Right sidebar tab. Four things were wrong before, and together they
        // explain the blank pane with no way to open it:
        //   1. `dsh.client.inject` did not list
        //      @deepseek-ai/dsh-client-ui-sidebar-right, so ctx.sidebarRightTabs
        //      was never visible in this module — the inject callback was
        //      skipped and nothing registered at all.
        //   2. no `guide` entry existed, so nothing could reach the tab.
        //   3. body/title must key off the definition *id*, which is what the
        //      seat dispatches on.
        //   4. `title` is called with the address being opened.
        // The shape below mirrors the shipped dsh-context plugin, which is the
        // live reference for this seat.
        ctx.inject(['sidebarRightTabs'], (scope) => {
          const tabs = scope.sidebarRightTabs
          if (!tabs || typeof tabs.register !== 'function') return
          const disposers = []
          const add = (d) => {
            if (typeof d === 'function') disposers.push(d)
          }
          try {
            add(
              tabs.register({
                id: NS,
                kind: NS,
                title: () => '黑魂3',
                guide: [
                  {
                    order: 20,
                    title: () => '黑魂3 进度',
                    description: () => '区域连通图、收集进度与下一步建议',
                    icon: (props) => h(Icon, props),
                  },
                ],
              }),
            )
            add(
              scope.slots.inject('sidebar.right.pane.tab', () =>
                scope.slots.register(
                  { name: 'sidebar.right.pane.tab', key: NS },
                  (props) => h(PaneBody, props),
                ),
              ),
            )
            add(
              scope.slots.inject('sidebar.right.pane.tab.title', () =>
                scope.slots.register(
                  { name: 'sidebar.right.pane.tab.title', key: NS },
                  () => h(TabTitle, null),
                ),
              ),
            )
          } catch {
            for (const d of disposers) {
              try {
                d?.()
              } catch {
                /* already disposed */
              }
            }
            return
          }
          return () => {
            for (const d of disposers) {
              try {
                d?.()
              } catch {
                /* already disposed */
              }
            }
          }
        })
      },
    }
  },
})

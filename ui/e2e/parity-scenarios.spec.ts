import { test, expect, type Browser, type Page } from '@playwright/test'
import {
  BOT_ID,
  OURS_EMAIL,
  OURS_PASSWORD,
  OURS_URL,
  PARITY_ENABLED,
  LEGACY_EMAIL,
  LEGACY_PASSWORD,
  LEGACY_URL,
  contentDelta,
  contentList,
  contentStructure,
  diffJson,
  exportBot,
  fetchContents,
  fetchFlows,
  fixtureOf,
  gridViolations,
  login,
  normalize,
  resetBot,
  type ContentElement,
  type Flow,
  type Session,
} from './parity-lib'
import { LegacyDriver, legacySignIn } from './parity-legacy'
import { OursDriver, oursSignIn } from './parity-ours'

// Data parity: the same edit sequence through legacy's UI and ours, then the saved flows from each
// server are compared structurally. Run with `make e2e-parity` (see e2e-ui/parity.sh).

type Ops = LegacyDriver | OursDriver
type Scenario = (d: Ops) => Promise<void>

const CANVAS_AT = { x: 700, y: 640 }

interface Scenarios {
  name: string
  run: Scenario
  /** Scenario-created nodes must sit on the 5-unit grid (drag and drop, legacy and ours alike). */
  checkGrid?: boolean
  /**
   * legacy inserts a skill node at the raw drop point (requestInsertNewSkill merges location x/y without
   * snapping), so only ours is held to the grid for skill nodes. Layout only; not a structural difference.
   */
  checkGridLEGACY?: boolean
  /**
   * Owner decision (2026-11-11): a paste duplicates the content its nodes refer to. legacy keeps the same
   * element id. Expected here: one extra element on ours with the same formData as the original, and the
   * copy's say action names that element. The structure is otherwise compared as usual.
   */
  copiesContent?: boolean
  /**
   * Fixture nodes the scenario moves. Their saved x/y must be on the 5-unit grid in both editors; the
   * exact value is not compared, because a drag is only as exact as the driver's pixel-to-unit mapping.
   */
  gridNodes?: string[]
  /** Compare the content elements the scenario adds or changes (type and formData; ids and dates ignored). */
  contentCheck?: boolean
  /** After the run, compare the whole exported bot (flows, skill flows, content elements), not only the studio API view. */
  wholeBot?: boolean
}

/** Position of a fresh session on one editor: a new context with the token already stored. */
async function sideOf(browser: Browser, side: 'legacy' | 'ours', s: Session): Promise<{ page: Page; close: () => Promise<void>; driver: (page: Page) => Ops }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  // Every action waits at most this long, so a missing control fails with its locator instead of hanging the test.
  page.setDefaultTimeout(20_000)
  if (side === 'legacy') {
    await legacySignIn(page, s)
    return { page, close: () => context.close(), driver: (p) => new LegacyDriver(p, s.base, BOT_ID) }
  }
  await oursSignIn(page, s)
  return { page, close: () => context.close(), driver: (p) => new OursDriver(p, s.base, BOT_ID) }
}

/** Runs one scenario on one editor from a freshly imported bot and returns the saved flows. */
async function runOn(browser: Browser, side: 'legacy' | 'ours', s: Session, flow: string, scenario: Scenario) {
  await resetBot(s)
  const before = await fetchFlows(s)
  const contentBefore = await fetchContents(s)
  const ctx = await sideOf(browser, side, s)
  try {
    const raw = ctx.driver(ctx.page)
    // Each driver step is logged, so a stuck step shows in the run output.
    const d = new Proxy(raw, {
      get(target, key) {
        const value = Reflect.get(target, key)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          console.log(`[parity] ${side} ${String(key)} ${JSON.stringify(args)}`)
          return value.apply(target, args)
        }
      },
    }) as Ops
    await d.openFlow(flow)
    await scenario(d)
    await (d as LegacyDriver | OursDriver).settle()
    // legacy writes trail the edit by a second or more (docs/editor-parity.md): let them land first.
    await ctx.page.waitForTimeout(side === 'legacy' ? 4000 : 1000)
    return { before, after: await fetchFlows(s), contentBefore, contentAfter: await fetchContents(s) }
  } finally {
    await ctx.close()
  }
}

const SCENARIOS: Scenarios[] = [
  {
    name: 'say action: new text element with typing, then an existing element picked',
    checkGrid: true,
    checkGridLEGACY: false,
    contentCheck: true,
    run: async (d) => {
      const name = await d.addStandard(CANVAS_AT)
      await d.sayNew(name, 'Halo dari parity')
      await d.sayPick(name, 'Silahkan masukkan nomor anda')
    },
  },
  {
    name: 'flow-wide transition (catchAll): add, then edit condition and target',
    run: async (d) => {
      await d.flowWideAdd('event.preview === "batal"', 'validation')
      await d.flowWideEdit(0, 'event.preview === "ulang"', 'Dev-flow')
    },
  },
  {
    name: 'retarget a linked transition in its transition dialog',
    run: async (d) => {
      // Select-Flow's third transition ('true') goes to validation; point it at wait-user-select.
      await d.retargetModal('Select-Flow', 2, 'wait-user-select')
    },
  },
  {
    name: 'standard node: add by drop, rename, move, delete',
    checkGrid: true,
    run: async (d) => {
      const name = await d.addStandard(CANVAS_AT)
      await d.rename(name, 'promo-baru')
      await d.move('promo-baru', 120, 60)
      await d.remove('promo-baru')
    },
  },
  {
    name: 'copy and paste a node',
    checkGrid: true,
    copiesContent: true,
    run: async (d) => {
      const copy = await d.copyPaste('validation')
      // legacy keeps a paste in memory until the next node move saves the flow (docs/editor-parity.md).
      // Moving the copy is the edit that makes it persist, in both editors.
      await d.move(copy, 60, 40)
    },
  },
  {
    name: 'flow: create, rename, duplicate, delete',
    run: async (d) => {
      await d.flowNew('parity-flow')
      await d.flowRename('parity-flow', 'parity-renamed')
      await d.flowDuplicate('parity-renamed', 'parity-copy')
      await d.flowDelete('parity-copy')
      await d.flowDelete('parity-renamed')
    },
  },
  {
    name: 'choice skill: insert from the palette (question, keyword, max retries)',
    checkGrid: true,
    checkGridLEGACY: false,
    run: async (d) => {
      await d.addChoice(CANVAS_AT, 'ini haya dev', 'ya', 2)
    },
  },
  {
    name: 'choice skill: edit max retries and a keyword of an existing choice node',
    run: async (d) => {
      await d.editChoice('dev-flow-choice', 'iya', 1)
    },
  },
  {
    name: 'rename a node that transitions in its flow target',
    run: async (d) => {
      // "validation" is the target of Select-Flow's transitions in main.
      await d.rename('validation', 'validasi-baru')
    },
  },
  {
    name: 'link: drag a new node output port to an existing node input port',
    checkGrid: true,
    checkGridLEGACY: false,
    run: async (d) => {
      const name = await d.addStandard(CANVAS_AT)
      await d.link(name, 0, 'validation')
    },
  },
  {
    name: 'move a fixture node: saved coordinates on the grid, same as legacy',
    gridNodes: ['Select-Flow'],
    run: async (d) => {
      await d.move('Select-Flow', 120, 60)
    },
  },
  {
    name: 'combined: node add, say, choice, link, rename, flow-wide, move (whole bot)',
    checkGrid: true,
    checkGridLEGACY: false,
    gridNodes: ['Select-Flow'],
    wholeBot: true,
    contentCheck: true,
    run: async (d) => {
      const name = await d.addStandard(CANVAS_AT)
      await d.rename(name, 'gabungan')
      await d.sayNew('gabungan', 'Gabungan parity')
      await d.addChoice({ x: 360, y: 300 }, 'ini haya dev', 'ya', 2)
      await d.link('gabungan', 0, 'validation')
      await d.fitView()
      await d.rename('validation', 'validasi-gabungan')
      await d.flowWideAdd('event.preview === "batal"', 'Select-Flow')
      await d.move('Select-Flow', 120, 60)
    },
  },
]

/** Flow files of an exported bot (flows/ and skills/), as Flow objects named by their path under the folder. */
function exportedFlows(files: Map<string, Buffer>): Flow[] {
  return [...files]
    .filter(([p]) => /(^|\/)(flows|skills)\/.*\.flow\.json$/.test(p))
    .map(([p, buf]) => ({ ...(JSON.parse(buf.toString('utf8')) as Flow), name: p.replace(/^.*?(flows|skills)\//, '') }))
}

/** Raw ui.json files of an exported bot (diagram layout, links), by path. */
function exportedUi(files: Map<string, Buffer>): Record<string, unknown> {
  return Object.fromEntries(
    [...files].filter(([p]) => /\.ui\.json$/.test(p)).map(([p, buf]) => [p, JSON.parse(buf.toString('utf8'))]),
  )
}

/**
 * Raw ui.json files, normalized with the same rules as the flows: generated node ids (and the ids of skill
 * flows a scenario created) become placeholders by first appearance; positions of generated nodes and of
 * nodes the scenario moves are dropped; link routing points are dropped; links are compared as a sorted set.
 */
function normalizeUi(files: Record<string, unknown>, fixture: { ids: Set<string>; flows: Set<string> }, layoutOnly: ReadonlySet<string>): Record<string, unknown> {
  const ids = new Map<string, string>()
  const idOf = (id: string) => {
    if (fixture.ids.has(id)) return id
    if (!ids.has(id)) ids.set(id, `ui-id${ids.size + 1}`)
    return ids.get(id)!
  }
  const isFixtureFile = (p: string) => fixture.flows.has(p.replace(/^flows\//, '').replace(/\.ui\.json$/, '.flow.json'))
  const out: Record<string, unknown> = {}
  let generated = 0
  for (const p of Object.keys(files).sort()) {
    const ui = files[p] as { nodes?: { id: string; position?: { x?: number; y?: number } }[]; links?: { source: string; target: string; points?: unknown }[] }
    const key = isFixtureFile(p) ? p : `generated-ui-${++generated}`
    const nodes = (ui.nodes ?? []).map((n) => {
      const generatedNode = !fixture.ids.has(n.id)
      const position = n.position && !generatedNode && !layoutOnly.has(n.id) ? n.position : undefined
      return { ...n, id: idOf(n.id), position: position ?? null }
    })
    const links = (ui.links ?? []).map((l) => {
      const { points: _points, ...rest } = l
      return { ...rest, source: idOf(l.source), target: idOf(l.target) }
    })
    links.sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1))
    out[key] = { ...ui, nodes, links }
  }
  return out
}

/** Content element files of an exported bot, without ids and dates, sorted per file. */
function exportedContent(files: Map<string, Buffer>): Record<string, unknown> {
  return Object.fromEntries(
    [...files]
      .filter(([p]) => /(^|\/)content-elements\/.*\.json$/.test(p))
      .map(([p, buf]) => [p, contentStructure(contentList(JSON.parse(buf.toString('utf8'))))]),
  )
}

test.describe('editor parity: legacy vs bot-engine', () => {
  test.skip(!PARITY_ENABLED, 'set LEGACY_URL, OURS_URL, LEGACY_EMAIL/PASSWORD, OURS_EMAIL/PASSWORD and BOT_TGZ (make e2e-parity)')
  test.describe.configure({ mode: 'serial', timeout: 240_000 })

  let legacy: Session
  let ours: Session

  test.beforeAll(async () => {
    legacy = await login(LEGACY_URL, LEGACY_EMAIL, LEGACY_PASSWORD)
    ours = await login(OURS_URL, OURS_EMAIL, OURS_PASSWORD)
  })

  for (const sc of SCENARIOS) {
    test(sc.name, async ({ browser }, testInfo) => {
      const a = await runOn(browser, 'legacy', legacy, 'main.flow.json', sc.run)
      const b = await runOn(browser, 'ours', ours, 'main.flow.json', sc.run)
      // The saved flows as each server returned them, for reading the diff against.
      await testInfo.attach('legacy-after.json', { body: JSON.stringify(a.after, null, 2), contentType: 'application/json' })
      await testInfo.attach('ours-after.json', { body: JSON.stringify(b.after, null, 2), contentType: 'application/json' })
      const fixture = fixtureOf(a.before)
      const layoutOnly = new Set(sc.gridNodes ?? [])
      let oursAfter: Flow[] = b.after
      if (sc.copiesContent) {
        const idsBefore = new Set(contentList(b.contentBefore).map((c) => c.id))
        const added = contentList(b.contentAfter).filter((c) => !idsBefore.has(c.id))
        expect(added, 'ours: one duplicated element per copied content element').toHaveLength(1)
        expect(contentList(a.contentAfter), 'legacy: a paste creates no element').toHaveLength(contentList(a.contentBefore).length)
        const original = contentList(b.contentBefore).filter((c) => JSON.stringify(c.formData) === JSON.stringify(added[0].formData))
        expect(original, 'ours: the duplicate has the formData of an existing element').not.toEqual([])
        // Point the copy's references back at the original id, so only the intended difference remains.
        const text = JSON.stringify(b.after).split(`#!${added[0].id}`).join(`#!${original[0].id}`)
        oursAfter = JSON.parse(text) as Flow[]
      }
      if (sc.contentCheck) {
        // The elements the scenario adds or changes must match in type and formData (ids and dates aside).
        expect(contentDelta(b.contentBefore, b.contentAfter), 'ours: content elements').toEqual(contentDelta(a.contentBefore, a.contentAfter))
      }
      if (sc.wholeBot) {
        const botLEGACY = await exportBot(legacy)
        const botOurs = await exportBot(ours)
        const flowLines = diffJson(
          normalize(exportedFlows(botLEGACY), fixture, layoutOnly),
          normalize(exportedFlows(botOurs), fixture, layoutOnly),
        )
        const contentLines = diffJson(exportedContent(botLEGACY), exportedContent(botOurs))
        // Raw ui.json: diagram layout and ids normalized as described at normalizeUi.
        const movedIds = new Set(a.before.flatMap((f) => f.nodes.filter((n) => layoutOnly.has(n.name)).map((n) => n.id)))
        const uiLines = diffJson(
          normalizeUi(exportedUi(botLEGACY), fixture, movedIds),
          normalizeUi(exportedUi(botOurs), fixture, movedIds),
        )
        if (process.env.PARITY_DUMP) {
          const { writeFileSync } = await import('node:fs')
          writeFileSync(`${process.env.PARITY_DUMP}/whole-bot.files.legacy.txt`, [...botLEGACY.keys()].join('\n'))
          writeFileSync(`${process.env.PARITY_DUMP}/whole-bot.files.ours.txt`, [...botOurs.keys()].join('\n'))
          writeFileSync(`${process.env.PARITY_DUMP}/whole-bot.flows.legacy.json`, JSON.stringify(exportedFlows(botLEGACY), null, 2))
          writeFileSync(`${process.env.PARITY_DUMP}/whole-bot.flows.ours.json`, JSON.stringify(exportedFlows(botOurs), null, 2))
          writeFileSync(`${process.env.PARITY_DUMP}/whole-bot.ui.legacy.json`, JSON.stringify(exportedUi(botLEGACY), null, 2))
          writeFileSync(`${process.env.PARITY_DUMP}/whole-bot.ui.ours.json`, JSON.stringify(exportedUi(botOurs), null, 2))
        }
        expect([...flowLines, ...contentLines].join('\n'), 'whole bot: flows and content elements').toBe('')
        expect(uiLines.join('\n'), 'whole bot: raw ui.json').toBe('')
      }
      const left = normalize(a.after, fixture, layoutOnly)
      const right = normalize(oursAfter, fixture, layoutOnly)
      const lines = diffJson(left, right)
      if (process.env.PARITY_DUMP) {
        const { writeFileSync } = await import('node:fs')
        writeFileSync(`${process.env.PARITY_DUMP}/${sc.name.replace(/\W+/g, '_')}.left.json`, JSON.stringify(left, null, 2))
        writeFileSync(`${process.env.PARITY_DUMP}/${sc.name.replace(/\W+/g, '_')}.right.json`, JSON.stringify(right, null, 2))
        writeFileSync(`${process.env.PARITY_DUMP}/${sc.name.replace(/\W+/g, '_')}.raw-ours.json`, JSON.stringify(b.after, null, 2))
        writeFileSync(`${process.env.PARITY_DUMP}/${sc.name.replace(/\W+/g, '_')}.raw-legacy.json`, JSON.stringify(a.after, null, 2))
      }
      if (sc.checkGrid) {
        expect(gridViolations(b.after, fixture), 'ours: new nodes off the 5-unit grid').toEqual([])
        if (sc.checkGridLEGACY !== false) expect(gridViolations(a.after, fixture), 'legacy: new nodes off the 5-unit grid').toEqual([])
      }
      if (sc.gridNodes) {
        // Fixture nodes the scenario moved: their saved x/y must be on the grid in both editors.
        const moved = (flows: Flow[]) => flows.flatMap((f) => f.nodes.filter((n) => sc.gridNodes!.includes(n.name)).map((n) => `${f.name} ${n.name}: ${n.x},${n.y}`))
        const offGrid = (flows: Flow[]) => moved(flows).filter((line) => !/: (-?\d+),(-?\d+)$/.test(line) || /: (-?\d+),(-?\d+)$/.exec(line)!.slice(1).some((v) => Number(v) % 5 !== 0))
        expect(offGrid(b.after), 'ours: moved node off the 5-unit grid').toEqual([])
        expect(offGrid(a.after), 'legacy: moved node off the 5-unit grid').toEqual([])
      }
      expect(lines, `structural diff (legacy vs ours):\n${lines.join('\n')}`).toEqual([])
    })
  }
})

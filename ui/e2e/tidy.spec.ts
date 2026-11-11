import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DSN, SHOTS, signIn } from './support'

// Tidy up on a dense synthetic flow (testdata/bots/synthetic-dense, imported by e2e-ui/run.sh as E2E_DENSE_BOT_ID).
// Canvas only: no emulator traffic reaches it.
const BOT = process.env.E2E_DENSE_BOT_ID ?? 'e2e-dense'
const MIN_GAP = 24

interface Box {
  id: string
  kind: 'node' | 'pill'
  start: boolean
  x: number
  y: number
  w: number
  h: number
}
type Seg = [number, number, number, number]

/** Node boxes in flow units (React Flow's transform and the unscaled offset size) and every edge's end points. */
async function measure(page: Page): Promise<{ boxes: Box[]; edges: Seg[] }> {
  return page.evaluate(() => {
    const boxes = [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map((el) => {
      const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform)
      return {
        id: el.dataset.id ?? '',
        kind: el.classList.contains('react-flow__node-terminal') ? ('pill' as const) : ('node' as const),
        start: el.innerText.includes('Start node'),
        x: Number(m?.[1] ?? 0),
        y: Number(m?.[2] ?? 0),
        w: el.offsetWidth,
        h: el.offsetHeight,
      }
    })
    // Each edge is a group: a wide hit path, then the visible stroke, then the arrow head.
    const edges = [...document.querySelectorAll<SVGPathElement>('g[data-edge-id] > path:nth-of-type(2)')].map((p) => {
      const nums = (p.getAttribute('d') ?? '').match(/-?\d+(?:\.\d+)?/g)!.map(Number)
      return [nums[0], nums[1], nums[nums.length - 2], nums[nums.length - 1]] as Seg
    })
    return { boxes, edges }
  })
}

/** Pairs of boxes closer than `gap` on both axes (gap 0: overlapping). Returns the ids involved. */
function crowded(boxes: Box[], gap = 0): string[] {
  const hit = new Set<string>()
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      const gx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w))
      const gy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h))
      if (gx < gap && gy < gap) {
        hit.add(a.id)
        hit.add(b.id)
      }
    }
  }
  return [...hit]
}

/** Edge crossings between the straight chords of the edges (source port to arrow tip). Edges sharing an end are skipped. */
function crossings(edges: Seg[]): number {
  const orient = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px))
  const same = (x1: number, y1: number, x2: number, y2: number) => Math.abs(x1 - x2) < 1 && Math.abs(y1 - y2) < 1
  let n = 0
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const [ax, ay, bx, by] = edges[i]
      const [cx, cy, dx, dy] = edges[j]
      if (same(ax, ay, cx, cy) || same(ax, ay, dx, dy) || same(bx, by, cx, cy) || same(bx, by, dx, dy)) continue
      const o1 = orient(ax, ay, bx, by, cx, cy)
      const o2 = orient(ax, ay, bx, by, dx, dy)
      const o3 = orient(cx, cy, dx, dy, ax, ay)
      const o4 = orient(cx, cy, dx, dy, bx, by)
      if (o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4) n++
    }
  }
  return n
}

function positionsOf(boxes: Box[]): Record<string, [number, number]> {
  return Object.fromEntries(boxes.map((b) => [b.id, [b.x, b.y]]))
}

/** md5 of one stored bot file (psql on the throwaway database). */
function md5Of(rel: string): string {
  const sql = `SELECT md5(content) FROM srv_ghost_files WHERE file_path = 'data/bots/${BOT}/${rel}' AND deleted = false`
  return execFileSync('psql', [DSN, '-X', '-tA', '-c', sql], { encoding: 'utf8' }).trim()
}

async function openFlow(page: Page, flow: string, style: 'Straight' | 'Orthogonal') {
  await signIn(page)
  await page.goto(`/studio/bots/${BOT}/flows?flow=${encodeURIComponent(flow)}`)
  await expect(page.locator('.react-flow__node').first()).toBeVisible()
  await page.getByRole('group', { name: 'Edges: Straight / Orthogonal' }).getByRole('button', { name: style, exact: true }).click()
  await expect(page.getByRole('group', { name: 'Edges: Straight / Orthogonal' }).getByRole('button', { name: style, exact: true })).toHaveAttribute('aria-pressed', 'true')
}

async function shotStyles(page: Page, slug: string, stage: string) {
  for (const style of ['Orthogonal', 'Straight'] as const) {
    await page.getByRole('group', { name: 'Edges: Straight / Orthogonal' }).getByRole('button', { name: style, exact: true }).click()
    await page.waitForTimeout(150)
    await page.screenshot({ path: join(SHOTS, `${slug}-${stage}-${style.toLowerCase()}.png`) })
  }
  await page.getByRole('group', { name: 'Edges: Straight / Orthogonal' }).getByRole('button', { name: 'Orthogonal', exact: true }).click()
}

async function tidy(page: Page, item: 'Fix overlaps' | 'Auto-arrange') {
  await page.getByRole('button', { name: 'Tidy up', exact: true }).click()
  await page.getByRole('menuitem', { name: new RegExp(`^${item}`) }).click()
  // The fit view animates for 300ms after the edit.
  await page.waitForTimeout(500)
}

async function savedAll(page: Page) {
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 15_000 })
}

test.describe('tidy up on a dense synthetic flow', () => {
  for (const flow of ['main.flow.json', 'secondary.flow.json']) {
    const slug = flow.replace('.flow.json', '')

    test(`${slug}: fix overlaps and auto-arrange leave no overlap, undo restores, flow.json unchanged`, async ({ page }) => {
      const report: Record<string, unknown> = { flow }
      await openFlow(page, flow, 'Orthogonal')
      await savedAll(page)
      // The fixture is hand-written, so the editor's first write puts the flow file in its own form.
      // Do one tidy edit and undo it, then take the checksum: from here on, only tidy and undo may run.
      await tidy(page, 'Fix overlaps')
      await savedAll(page)
      await page.keyboard.press('Control+z')
      await savedAll(page)
      const flowMd5Before = md5Of(`flows/${flow}`)
      const before = await measure(page)
      report.before = {
        nodes: before.boxes.filter((b) => b.kind === 'node').length,
        pills: before.boxes.filter((b) => b.kind === 'pill').length,
        overlapping: crowded(before.boxes).length,
        crowded: crowded(before.boxes, MIN_GAP).length,
        edges: before.edges.length,
        crossings: crossings(before.edges),
      }
      await shotStyles(page, slug, '0-before')
      if (crowded(before.boxes).length > 0) {
        await expect(page.getByRole('status').filter({ hasText: 'overlap' })).toBeVisible()
      }

      // Fix overlaps from the menu: no overlap left, the rest of the layout is where it was.
      await tidy(page, 'Fix overlaps')
      await expect.poll(async () => crowded((await measure(page)).boxes).length, { timeout: 5_000 }).toBe(0)
      const afterFix = await measure(page)
      report.afterFix = {
        overlapping: crowded(afterFix.boxes).length,
        crowded: crowded(afterFix.boxes, MIN_GAP).length,
        crossings: crossings(afterFix.edges),
        moved: Object.keys(positionsOf(before.boxes)).filter((id) => {
          const a = positionsOf(before.boxes)[id]
          const b = positionsOf(afterFix.boxes)[id]
          return a[0] !== b[0] || a[1] !== b[1]
        }).length,
      }
      await shotStyles(page, slug, '1-fix')
      await savedAll(page)

      // One undo step restores the layout the user had.
      await page.keyboard.press('Control+z')
      await expect.poll(async () => JSON.stringify(positionsOf((await measure(page)).boxes)), { timeout: 5_000 }).toBe(
        JSON.stringify(positionsOf(before.boxes)),
      )

      // Auto-arrange: a clean layout from the start node, positions on the 5-unit grid.
      await tidy(page, 'Auto-arrange')
      await expect.poll(async () => crowded((await measure(page)).boxes).length, { timeout: 5_000 }).toBe(0)
      const arranged = await measure(page)
      const real = arranged.boxes.filter((b) => b.kind === 'node')
      const start = real.find((b) => b.start)
      const minX = Math.min(...real.map((b) => b.x))
      report.afterArrange = {
        overlapping: crowded(arranged.boxes).length,
        crowded: crowded(arranged.boxes, MIN_GAP).length,
        crossings: crossings(arranged.edges),
        startAtLeftColumn: start !== undefined && start.x === minX,
        offGrid: real.filter((b) => b.x % 5 !== 0 || b.y % 5 !== 0).length,
      }
      expect(start).toBeDefined()
      expect(start!.x).toBe(minX)
      await shotStyles(page, slug, '2-arrange')
      await savedAll(page)

      // Undo back to the original layout, then wait for the save and compare the flow file.
      await page.keyboard.press('Control+z')
      await expect.poll(async () => JSON.stringify(positionsOf((await measure(page)).boxes)), { timeout: 5_000 }).toBe(
        JSON.stringify(positionsOf(before.boxes)),
      )
      await savedAll(page)
      const flowMd5After = md5Of(`flows/${flow}`)
      report.flowJsonUnchanged = flowMd5After === flowMd5Before
      writeFileSync(join(SHOTS, `${slug}-report.json`), JSON.stringify(report, null, 2))
      expect(flowMd5After).toBe(flowMd5Before)
    })
  }

  test('the overlap hint shows on open, fixes on click and can be dismissed', async ({ page }) => {
    await openFlow(page, 'main.flow.json', 'Orthogonal')
    await savedAll(page)
    const status = page.getByRole('status').filter({ hasText: 'overlap' })
    await expect(status).toBeVisible()
    await expect(status).toContainText(/^\d+ nodes? overlap/)
    await status.getByRole('button', { name: 'Fix overlaps', exact: true }).click()
    await expect.poll(async () => crowded((await measure(page)).boxes).length, { timeout: 5_000 }).toBe(0)
    await expect(page.getByRole('status').filter({ hasText: 'overlap' })).toHaveCount(0)
    await page.keyboard.press('Control+z')
    await expect(page.getByRole('status').filter({ hasText: 'overlap' })).toBeVisible()
    await page.getByRole('button', { name: 'Dismiss' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'overlap' })).toHaveCount(0)
  })
})

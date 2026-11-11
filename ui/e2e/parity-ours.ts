import { expect, type Locator, type Page } from '@playwright/test'
import { dragNodeBy, type Session } from './parity-lib'
import type { Point } from './parity-legacy'

// Drives the bot-engine editor (ours) through its UI, with the same operations as LegacyDriver.

export async function oursSignIn(page: Page, s: Session) {
  await page.goto(`${s.base}/studio/login`)
  await page.evaluate((jwt) => window.localStorage.setItem('bot-engine.jwt', jwt), s.jwt)
}

export class OursDriver {
  constructor(
    readonly page: Page,
    readonly base: string,
    readonly botId: string,
  ) {}

  canvas(): Locator {
    return this.page.locator('.react-flow__pane')
  }

  node(name: string): Locator {
    return this.page.locator('.react-flow__node').filter({ has: this.page.getByText(name, { exact: true }) }).first()
  }

  async openFlow(flow: string) {
    await this.page.goto(`${this.base}/studio/bots/${this.botId}/flows?flow=${encodeURIComponent(flow)}`)
    await expect(this.page.locator('.react-flow__node').first()).toBeVisible({ timeout: 30_000 })
    await this.settle()
  }

  /** Autosave: wait for the saved state (a flow with no unsaved edits shows Saved). */
  async settle() {
    await expect(this.page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 15_000 })
    await this.page.waitForTimeout(300)
  }

  async addStandard(at: Point): Promise<string> {
    const before = await this.page.locator('.react-flow__node').count()
    await this.dropFromPalette('Node', at)
    await expect(this.page.locator('.react-flow__node')).toHaveCount(before + 1, { timeout: 10_000 })
    await this.settle()
    return this.lastNodeName()
  }

  /** The node the page selects after a creation: its name in the properties panel. */
  async lastNodeName(): Promise<string> {
    const input = this.page.getByLabel('Node name')
    await expect(input).toBeVisible()
    return input.inputValue()
  }

  private async dropFromPalette(label: 'Node' | 'Choice', at: Point) {
    const pane = this.canvas()
    const box = await pane.boundingBox()
    if (!box) throw new Error('no pane')
    await this.page.getByText(label, { exact: true }).first().dragTo(pane, { targetPosition: { x: at.x - box.x, y: at.y - box.y } })
  }

  async select(name: string) {
    await this.node(name).locator('span.truncate').first().click()
    await this.settle()
  }

  async rename(name: string, to: string) {
    await this.select(name)
    const input = this.page.getByLabel('Node name')
    await input.fill(to)
    await input.press('Enter')
    await this.settle()
  }

  /**
 * Moves a node by a canvas offset (units, not screen pixels: the two editors open at different zoom).
 * The grid snap is the editor's own (5 units).
 */
  async move(name: string, dx: number, dy: number) {
    const scale = await this.zoomScale()
    const header = this.node(name).locator('span.truncate').first()
    const box = await header.boundingBox()
    if (!box) throw new Error(`no node ${name}`)
    await dragNodeBy(
      this.page,
      async () => header.boundingBox(),
      { x: box.x + 4, y: box.y + 4 },
      dx * scale,
      dy * scale,
    )
    await this.settle()
  }

  /** Screen pixels per canvas unit: the zoom label (e.g. "48%"). */
  async zoomScale(): Promise<number> {
    const label = await this.page.getByText(/^\d+%$/).first().innerText()
    return Number(label.replace('%', '')) / 100
  }

  async remove(name: string) {
    await this.select(name)
    await this.page.keyboard.press('Delete')
    await this.settle()
  }

  async copyPaste(name: string): Promise<string> {
    await this.select(name)
    await this.page.keyboard.press('Control+c')
    await this.page.keyboard.press('Control+v')
    await this.settle()
    return `${name}-copy`
  }

  /** Links transition `index` of `from` to node `to`: drag from its output handle to the target's input handle. */
  async link(from: string, index: number, to: string) {
    const src = this.node(from).locator(`.react-flow__handle[data-handleid="t${index}"]`).first()
    const dst = this.node(to).locator('.react-flow__handle[data-handleid="in"]').first()
    const a = await src.boundingBox()
    const b = await dst.boundingBox()
    if (!a || !b) throw new Error('no handle to link')
    await this.page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    await this.page.mouse.down()
    for (let i = 1; i <= 10; i++) {
      await this.page.mouse.move(a.x + ((b.x + b.width / 2 - a.x - a.width / 2) * i) / 10, a.y + ((b.y + b.height / 2 - a.y - a.height / 2) * i) / 10)
    }
    await this.page.mouse.up()
    await this.settle()
  }

 // ---- choice skill ----------------------------------------------------------------------------

  /** Titles of the nodes on the canvas (the header text of each node). */
  async nodeTitles(): Promise<string[]> {
    return this.page.locator('.react-flow__node').evaluateAll((els) =>
      els.map((el) => el.querySelector('span.truncate')?.textContent?.trim() ?? '').filter(Boolean),
    )
  }

  /** Same as LegacyDriver.addChoice: question by its text, one extra keyword, max retries. Returns the node name. */
  async addChoice(at: Point, question: string, keyword: string, maxRetries: number): Promise<string> {
    const before = new Set(await this.nodeTitles())
    await this.dropFromPalette('Choice', at)
    const dialog = this.page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    const value = await dialog.locator('#choice-question option', { hasText: question }).first().getAttribute('value')
    await dialog.locator('#choice-question').selectOption(value ?? '')
    await this.fillChoiceFields(dialog, keyword, maxRetries)
    await dialog.getByRole('button', { name: 'Insert', exact: true }).click()
    await this.settle()
    const created = (await this.nodeTitles())
      .filter((t) => !before.has(t))
      .map((t) => t.match(/choice-[0-9a-z]{6}/)?.[0])
      .filter((t): t is string => Boolean(t))
    if (created.length !== 1) throw new Error(`expected one new choice node, got ${JSON.stringify(created)}`)
    return created[0]
  }

  /** Double-click opens the choice editor (same as legacy). */
  async editChoice(name: string, keyword: string, maxRetries: number) {
 // The node can sit under another node on the canvas (fixture layout), so the event is dispatched on
 // the node itself: a real click would land on the node drawn over it.
    await this.node(name).dispatchEvent('dblclick', undefined, { timeout: 10_000 })
    const dialog = this.page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await this.fillChoiceFields(dialog, keyword, maxRetries)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await this.settle()
  }

  private async fillChoiceFields(dialog: Locator, keyword: string, maxRetries: number) {
    if (keyword) {
      const input = dialog.getByLabel(/^Keywords for/).first()
      await input.fill(keyword)
      await input.press('Enter')
    }
    await dialog.getByLabel('Max attempts').fill(String(maxRetries))
    await this.settle()
  }

 // ---- say actions and transitions -------------------------------------------------------------

  /** Opens "Add action" in the On enter list of the selected node (the first one in the panel). */
  private async openAddAction(name: string): Promise<Locator> {
    await this.select(name)
    await this.page.getByRole('button', { name: 'Add action', exact: true }).first().click()
    const dialog = this.page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    return dialog
  }

  async sayNew(name: string, text: string) {
    const dialog = await this.openAddAction(name)
    await dialog.locator('#content-text').fill(text)
    await dialog.getByRole('button', { name: 'Add action (Alt+Enter)', exact: true }).click()
    await this.settle()
  }

  async sayPick(name: string, text: string) {
    const dialog = await this.openAddAction(name)
    await dialog.getByRole('tab', { name: 'Pick existing' }).click()
    const value = await dialog.locator('#pick-content option', { hasText: text }).first().getAttribute('value')
    await dialog.locator('#pick-content').selectOption(value ?? '')
    await dialog.getByRole('button', { name: 'Add action (Alt+Enter)', exact: true }).click()
    await this.settle()
  }

  /** Condition (raw expression when given, else unchanged) and target node, in the transition dialog. */
  private async fillTransition(dialog: Locator, condition: string | null, target: string) {
    if (condition !== null) {
      await dialog.getByRole('radio', { name: 'Raw expression', exact: true }).click()
      await dialog.getByRole('textbox', { name: 'Raw expression' }).fill(condition)
    }
    await dialog.getByRole('radio', { name: 'Transition to node', exact: true }).click()
    await dialog.getByLabel('Target node').selectOption(target)
  }

  private flowWidePanel(): Locator {
    return this.page.locator('aside').filter({ hasText: 'Flow-wide' })
  }

  private async openFlowWideTransitions() {
    if (!(await this.flowWidePanel().isVisible())) {
      await this.page.getByRole('button', { name: /flow-wide transitions?/ }).click()
    }
    await this.flowWidePanel().getByRole('tab', { name: 'Transitions' }).click()
  }

  async flowWideAdd(condition: string, target: string) {
    await this.openFlowWideTransitions()
    await this.flowWidePanel().getByRole('button', { name: 'Add transition', exact: true }).click()
    const dialog = this.page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await this.fillTransition(dialog, condition, target)
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await this.settle()
  }

  async flowWideEdit(index: number, condition: string, target: string) {
    await this.openFlowWideTransitions()
    await this.flowWidePanel().getByRole('button', { name: 'Edit flow-wide transition' }).nth(index).click()
    const dialog = this.page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await this.fillTransition(dialog, condition, target)
    await dialog.getByRole('button', { name: 'Update', exact: true }).click()
    await this.settle()
  }

  /** Retargets transition `index` of `from` in its dialog (Edit transition): keeps the condition. */
  async retargetModal(from: string, index: number, to: string) {
    await this.select(from)
 // The node inspector has On enter / On receive / Transitions tabs.
    await this.page.getByRole('tab', { name: 'Transitions', exact: true }).click()
    await this.page.getByRole('button', { name: 'Edit transition', exact: true }).nth(index).click()
    const dialog = this.page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await this.fillTransition(dialog, null, to)
    await dialog.getByRole('button', { name: 'Update', exact: true }).click()
    await this.settle()
  }

 // ---- flows -----------------------------------------------------------------------------------

  async flowNew(name: string) {
    await this.page.getByRole('button', { name: 'New flow' }).click()
    await this.fillFlowName(name, 'Create flow')
  }

  /** The row's Rename, Duplicate and Delete buttons only render while the row is hovered. */
  private async rowAction(from: string, action: 'Rename' | 'Duplicate' | 'Delete') {
    await this.page.getByRole('button', { name: from, exact: true }).hover()
    await this.page.getByRole('button', { name: `${action} ${from}.flow.json` }).click()
  }

  async flowRename(from: string, to: string) {
    await this.rowAction(from, 'Rename')
    await this.fillFlowName(to, 'Rename')
  }

  async flowDuplicate(from: string, to: string) {
    await this.rowAction(from, 'Duplicate')
    await this.fillFlowName(to, 'Duplicate')
  }

  async flowDelete(name: string) {
    this.page.once('dialog', (d) => void d.accept())
    await this.rowAction(name, 'Delete')
    await this.settle()
  }

  private async fillFlowName(name: string, submit: string) {
    const dialog = this.page.getByRole('dialog')
    await dialog.locator('input').first().fill(name)
    await dialog.getByRole('button', { name: submit, exact: true }).click()
    await this.settle()
  }
}

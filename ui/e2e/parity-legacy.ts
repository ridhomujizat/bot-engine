import { expect, type Locator, type Page } from '@playwright/test'
import { dragNodeBy, type Session } from './parity-lib'

// Drives legacy editor (the reference editor) through its own UI. Selectors come from the
// legacy source (the FlowBuilder view): palette #btn-tool-<id>, #diagramContainer,
// inspector name input, Blueprint dialogs. Never sends emulator messages.

export type Point = { x: number; y: number }

/** Session cookie-less login: the legacy UI reads the token from bp/token in both storages. */
export async function legacySignIn(page: Page, s: Session) {
  await page.addInitScript(
    ([token, exp, iat]) => {
      // The guided tour blocks the canvas on first visit.
      for (const store of [localStorage, sessionStorage]) {
        store.setItem('guidedTour11_9_0', 'true')
        store.setItem('bp/token', JSON.stringify({ token, expiresAt: exp, issuedAt: iat }))
      }
    },
    [s.jwt, s.exp, s.iat] as const,
  )
  await page.goto(`${s.base}/admin/`)
}

export class LegacyDriver {
  constructor(
    readonly page: Page,
    readonly base: string,
    readonly botId: string,
  ) {}

  canvas(): Locator {
    return this.page.locator('#diagramContainer')
  }

  /** The rendered node whose title is `name`. */
  node(name: string): Locator {
    return this.page.locator('[data-nodeid]').filter({ has: this.page.getByText(name, { exact: true }) }).first()
  }

  async openFlow(flow: string) {
    // Flow files are addressed by their list name: main.flow.json opens as "main".
    const slug = flow.replace(/\.flow\.json$/, '').replace(/^main$/, 'main')
    await this.page.goto(`${this.base}/studio/${this.botId}/flows/${slug}`)
    await expect(this.page.locator('#btn-tool-standard')).toBeVisible({ timeout: 30_000 })
    await this.page.keyboard.press('Escape')
    await this.page.locator('.bp3-dialog-close-button').first().click({ timeout: 1000 }).catch(() => {})
    await this.settle()
  }

  /** legacy saves each change at once: wait until no flow write is in flight and the canvas is quiet. */
  async settle() {
    await this.page.waitForLoadState('networkidle').catch(() => {})
    await this.page.waitForTimeout(1200)
  }

  /** Titles of the nodes on the canvas (the element text, not the ports or links drawn with them). */
  async nodeTitles(): Promise<string[]> {
    return this.page.locator('[data-nodeid]').evaluateAll((els) =>
      [...new Set(els.map((el) => ((el as HTMLElement).innerText ?? '').split('\n')[0].trim()))].filter(Boolean),
    )
  }

  /** Drops a standard node at a canvas point; returns the name legacy gives it (node-xxxx). */
  async addStandard(at: Point): Promise<string> {
    const before = new Set(await this.nodeTitles())
    await this.page.locator('#btn-tool-standard').dragTo(this.canvas(), { targetPosition: at })
    await this.settle()
    const created = (await this.nodeTitles()).filter((t) => /^node-[0-9a-f]{4}$/.test(t) && !before.has(t))
    if (created.length !== 1) throw new Error(`expected one new node, got ${JSON.stringify(created)}`)
    return created[0]
  }

  /** Name of the node the inspector shows (legacy opens it on creation). */
  async lastNodeName(): Promise<string> {
    const input = this.page.locator('input[class*="name"]').first()
    await expect(input).toBeVisible()
    return input.inputValue()
  }

  async select(name: string) {
    await this.node(name).locator('text=/./').first().click({ force: true })
    await this.settle()
  }

  async rename(name: string, to: string) {
    await this.select(name)
    const input = this.page.locator('input[class*="name"]').first()
    await input.fill(to)
    await input.press('Enter')
    await this.settle()
  }

  /**
   * Moves a node by a canvas offset (units, not screen pixels: the two editors open at different zoom).
   * legacy snaps the result to its grid.
   */
  async move(name: string, dx: number, dy: number) {
    const scale = await this.zoomScale()
    const box = await this.node(name).boundingBox()
    if (!box) throw new Error(`no node ${name}`)
    await dragNodeBy(
      this.page,
      async () => this.node(name).boundingBox(),
      { x: box.x + box.width / 2, y: box.y + 6 },
      dx * scale,
      dy * scale,
    )
    await this.settle()
  }

  /** Screen pixels per canvas unit: the zoom label (e.g. "61%"). */
  async zoomScale(): Promise<number> {
    const label = await this.page.getByText(/^\d+%$/).first().innerText()
    return Number(label.replace('%', '')) / 100
  }

  async remove(name: string) {
    await this.select(name)
    await this.canvas().focus()
    await this.page.keyboard.press('Delete')
    await this.settle()
  }

  /** Fits every node in the view (the diagram toolbar's zoom-to-fit). */
  async fitView() {
    await this.page.locator('.bp3-icon-zoom-to-fit').first().click({ timeout: 10_000 })
    await this.settle()
  }

  /** Copies a node and pastes it with Ctrl+V; returns the copy's name (legacy copyName). */
  async copyPaste(name: string): Promise<string> {
    await this.select(name)
    await this.page.keyboard.press('Control+c')
    await this.page.keyboard.press('Control+v')
    await this.settle()
    return `${name}-copy`
  }

  /**
   * Links transition `index` of `from` to node `to`: drag from the output port to the target's input port.
   * legacy ports are storm-react-diagrams divs (data-name="out<n>" / "in", inside the node).
   */
  async link(from: string, index: number, to: string) {
    // Fit the canvas first: a node dropped far from the origin sits behind the Inspector otherwise.
    await this.page.locator('.bp3-icon-zoom-to-fit').first().click()
    await this.settle()
    const src = this.node(from).locator(`[data-name="out${index}"]`).first()
    const dst = this.node(to).locator('[data-name="in"]').first()
    await this.dragBetween(src, dst)
    await this.settle()
  }

  private async dragBetween(src: Locator, dst: Locator) {
    const a = await src.boundingBox()
    const b = await dst.boundingBox()
    if (!a || !b) throw new Error('no port to link')
    await this.page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    await this.page.mouse.down()
    for (let i = 1; i <= 10; i++) {
      await this.page.mouse.move(a.x + ((b.x + b.width / 2 - a.x - a.width / 2) * i) / 10, a.y + ((b.y + b.height / 2 - a.y - a.height / 2) * i) / 10)
    }
    await this.page.mouse.up()
  }

  // ---- choice skill ----------------------------------------------------------------------------

  /**
   * Inserts a choice skill: the choice tool dropped on the canvas, a question picked through legacy's
   * content picker, one extra keyword on the first choice, and max retries (Advanced tab).
   * Returns the name legacy gives the new skill node (choice-<6>).
   */
  async addChoice(at: Point, question: string, keyword: string, maxRetries: number): Promise<string> {
    const before = new Set(await this.nodeTitles())
    await this.page.locator('#btn-tool-choice').dragTo(this.canvas(), { targetPosition: at })
    const dialog = this.choiceDialog()
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    // The picker's folder button (the input itself is disabled; its wrapper opens the picker too).
    await dialog.locator('.bp3-icon-folder-open').first().click()
    await this.pickFromContentPicker(question)
    await this.fillChoiceFields(dialog, keyword, maxRetries)
    await dialog.locator('.bp3-dialog-footer').getByRole('button', { name: 'Insert', exact: true }).click()
    await this.settle()
    // The node header reads "Choice | choice-<6>" in legacy: the name is the part after the bar.
    const created = (await this.nodeTitles())
      .filter((t) => !before.has(t))
      .map((t) => t.match(/choice-[0-9a-z]{6}/)?.[0])
      .filter((t): t is string => Boolean(t))
    if (created.length !== 1) throw new Error(`expected one new choice node, got ${JSON.stringify(created)}`)
    return created[0]
  }

  /** Opens a choice skill node in its editor (double-click) and sets max retries and one extra keyword. */
  async editChoice(name: string, keyword: string, maxRetries: number) {
    // Skill nodes read "Choice | <name>" in legacy, so match the name as part of the header. The skill
    // editor opens from the properties panel of the selected node ("Edit skill").
    await this.page.locator('[data-nodeid]').filter({ hasText: name }).first().locator('text=/./').first().click({ force: true })
    await this.settle()
    await this.page.getByRole('button', { name: 'Edit skill', exact: true }).click()
    const dialog = this.choiceDialog()
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await this.fillChoiceFields(dialog, keyword, maxRetries)
    await dialog.locator('.bp3-dialog-footer').getByRole('button', { name: 'Save', exact: true }).click()
    await this.settle()
  }

  private choiceDialog(): Locator {
    return this.page.locator('.bp3-dialog').filter({ hasText: 'Change the question and choices' })
  }

  /** Picks an item of legacy's content picker (a Blueprint dialog listing the question elements). */
  private async pickFromContentPicker(text: string) {
    const item = this.page.locator('.bp3-dialog .list-group-item-action', { hasText: text }).first()
    await expect(item).toBeVisible({ timeout: 10_000 })
    await item.click()
    await this.settle()
  }

  private async fillChoiceFields(dialog: Locator, keyword: string, maxRetries: number) {
    if (keyword) {
      const tag = dialog.locator('.bp3-tag-input input').first()
      await tag.fill(keyword)
      await tag.press('Enter')
    }
    await dialog.locator('.bp3-tab', { hasText: 'Advanced' }).click()
    const retries = dialog.locator('#inputMaxRetries')
    await retries.fill(String(maxRetries))
    await retries.press('Tab')
    await this.settle()
  }

  // ---- say actions and transitions -------------------------------------------------------------

  /** The action modal (Say Something / Execute code), found by its submit button. */
  private actionModal(): Locator {
    return this.page.locator('.bp3-dialog').filter({ has: this.page.locator('#btn-submit-action') })
  }

  /** Opens "add action" on the selected node (its On enter list is the first one in the panel). */
  private async openAddAction(name: string) {
    await this.select(name)
    await this.page.locator('#btn-add-element').first().click()
    await expect(this.actionModal()).toBeVisible({ timeout: 15_000 })
  }

  /** The content picker, opened from the action modal and past its category step (`category`: All, Text, ...). */
  private async openPicker(category: string): Promise<Locator> {
    await this.actionModal().locator('.bp3-icon-folder-open').first().click()
    const picker = this.page.locator('.bp3-dialog').filter({ hasText: 'Pick Content' })
    await expect(picker).toBeVisible({ timeout: 10_000 })
    // The picker opens on its category step unless it was given a content type; wait for whichever step shows.
    const categoryStep = picker.getByText('Select a category')
    const listStep = picker.getByLabel('Search content elements')
    await expect(categoryStep.or(listStep)).toBeVisible({ timeout: 10_000 })
    if (await categoryStep.isVisible()) await picker.getByText(category, { exact: true }).click({ timeout: 10_000 })
    await expect(listStep).toBeVisible({ timeout: 10_000 })
    return picker
  }

  /**
   * Say something with a new text element: the picker's "Create new Text", then the text form. The message is
   * a Draft.js editor; typing indicators are on (legacy default, stored as typing$en true), markdown stays off.
   */
  async sayNew(name: string, text: string) {
    await this.openAddAction(name)
    const picker = await this.openPicker('Text')
    await picker.getByText('Create new Text', { exact: true }).click({ timeout: 10_000 })
    const form = this.page.locator('#content-form')
    await expect(form).toBeVisible({ timeout: 10_000 })
    const message = form.locator('[contenteditable="true"]').first()
    await message.click({ timeout: 10_000 })
    await message.pressSequentially(text, { timeout: 10_000 })
    const typing = form.locator('#root_typing')
    if (!(await typing.isChecked())) await typing.check({ timeout: 10_000 })
    await form.locator('button[type="submit"]').click({ timeout: 10_000 })
    await this.settle()
    await this.submitAction()
  }

  /** Say something with an existing element, picked by its text in the content picker. */
  async sayPick(name: string, text: string) {
    await this.openAddAction(name)
    const picker = await this.openPicker('All')
    await picker.getByLabel('Search content elements').fill(text)
    await picker.locator('.list-group-item-action', { hasText: text }).first().click()
    await this.settle()
    await this.submitAction()
  }

  private async submitAction() {
    await this.page.locator('#btn-submit-action').click()
    await this.settle()
  }

  private transitionModal(): Locator {
    return this.page.locator('.bp3-dialog').filter({ hasText: 'condition to transition' })
  }

  /** Condition (raw expression when given, else unchanged) and target node, in the transition modal. */
  private async fillTransition(modal: Locator, condition: string | null, target: string) {
    if (condition !== null) {
      await modal.locator('label', { hasText: 'Raw Expression (advanced)' }).click()
      // The expression is a Draft.js editor (its placeholder is a text node, not an attribute).
      const expression = modal.locator('[contenteditable="true"]').first()
      await expression.click()
      await this.page.keyboard.press('Control+A')
      await expression.pressSequentially(condition)
    }
    await modal.locator('label', { hasText: 'Transition to node' }).click({ timeout: 10_000 })
    // The node target is a react-select. Open its control (the innermost container of the hidden input named
    // flowToNode), type the name to filter, then click the option whose text is exactly this name: the filter
    // is case-insensitive, so Enter would pick "dev-flow-choice" for "Dev-flow".
    await modal.locator('div').filter({ has: this.page.locator('input[name="flowToNode"]') }).last().click({ timeout: 10_000 })
    await this.page.keyboard.type(target)
    const esc = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    await this.page.locator('[id*="-option-"]').filter({ hasText: new RegExp(`^${esc}$`) }).first().click({ timeout: 10_000 })
  }

  private async submitTransition(modal: Locator, label: 'Create' | 'Update') {
    await modal.locator('.bp3-dialog-footer').getByRole('button', { name: label, exact: true }).click()
    await this.settle()
  }

  /** Opens the flow-wide panel (bar above the canvas) on its Transitions tab. */
  private async openFlowWideTransitions() {
    // The flow properties tabs read "N On Receive" and "N Transitions" (the bar above the canvas reads lower case).
    // Always through the bar: a node may still be selected, and its own Transitions tab reads the same way.
    await this.page.locator('button', { hasText: 'flow-wide transition' }).first().click({ timeout: 10_000 })
    await this.page.getByRole('button', { name: /\d+ Transitions$/ }).click({ timeout: 10_000 })
    await this.settle()
  }

  async flowWideAdd(condition: string, target: string) {
    await this.openFlowWideTransitions()
    await this.page.locator('#transition-section #btn-add-element').first().click({ timeout: 10_000 })
    const modal = this.transitionModal()
    await expect(modal).toBeVisible({ timeout: 15_000 })
    await this.fillTransition(modal, condition, target)
    await this.submitTransition(modal, 'Create')
  }

  /** Edits flow-wide transition `index` (double-click its row): new condition and target. */
  async flowWideEdit(index: number, condition: string, target: string) {
    await this.openFlowWideTransitions()
    await this.page.locator('#transition-section [data-rbd-draggable-id]').nth(index).dblclick({ timeout: 10_000 })
    const modal = this.transitionModal()
    await expect(modal).toBeVisible({ timeout: 15_000 })
    await this.fillTransition(modal, condition, target)
    await this.submitTransition(modal, 'Update')
  }

  /** Retargets transition `index` of `from` in its modal (double-click its row): keeps the condition. */
  async retargetModal(from: string, index: number, to: string) {
    await this.select(from)
    // The node panel has the same On enter / On receive / Transitions tabs as the flow panel.
    await this.page.getByRole('button', { name: /\d+ Transitions$/ }).click({ timeout: 10_000 })
    await this.settle()
    await this.page.locator('#transition-section [data-rbd-draggable-id]').nth(index).dblclick({ timeout: 10_000 })
    const modal = this.transitionModal()
    await expect(modal).toBeVisible({ timeout: 15_000 })
    await this.fillTransition(modal, null, to)
    await this.submitTransition(modal, 'Update')
  }

  // ---- flows: side panel -----------------------------------------------------------------------

  async flowNew(name: string) {
    // The "+" in the Flows panel header. The page runs at a fixed 1440x900 viewport, where it sits at (259, 68).
    await this.page.mouse.click(259, 68)
    await this.fillFlowName(name, 'Create')
  }

  async flowRename(from: string, to: string) {
    await this.flowMenu(from, 'Rename')
    await this.fillFlowName(to, 'Rename')
  }

  async flowDuplicate(from: string, to: string) {
    await this.flowMenu(from, 'Duplicate')
    await this.fillFlowName(to, 'Duplicate')
  }

  async flowDelete(name: string) {
    await this.flowMenu(name, 'Delete')
    // The confirm dialog's accept button is labelled "Delete" (confirmDialog in the studio shared UI).
    await this.page.locator('.bp3-overlay-open').getByRole('button', { name: 'Delete', exact: true }).click()
    await this.settle()
  }

  private flowItem(name: string): Locator {
    return this.page.locator('.bp3-tree-node-content, .bp3-tree-node').filter({ hasText: name }).first()
  }

  private async flowMenu(name: string, item: string) {
    await this.flowItem(name).click({ button: 'right' })
    await this.page.locator('.bp3-menu-item').filter({ hasText: item }).first().click()
  }

  private async fillFlowName(name: string, submit: string) {
    const dialog = this.page.locator('.bp3-dialog')
    await dialog.locator('input').first().fill(name)
    await dialog.getByRole('button', { name: submit, exact: true }).click()
    await this.settle()
  }
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Braces, MessageSquare, Redo2, Save, Undo2, Workflow } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useParams, useSearchParams } from 'react-router'
import {
  createFlow,
  deleteFlow,
  generateChoiceFlow,
  listActions,
  listContentElements,
  listFlows,
  saveContentElement,
  saveFlow,
} from '@/api/studio'
import type { ActionDef, CatchAll, ContentElement, FlowJson, FlowNodeJson, FlowView, Point, Transition } from '@/api/types'
import { Rail, Topbar } from '@/app/AppShell'
import { Button } from '@/components/ui/button'
import { EmulatorPanel } from '@/emulator/EmulatorPanel'
import { triggerTexts } from '@/emulator/metadata'
import { useEmulator } from '@/emulator/useEmulator'
import { cn } from '@/lib/utils'
import { ActionDialog } from './ActionDialog'
import { ChoiceSkillDialog, type ChoiceSkillValues } from './ChoiceSkillDialog'
import { contentPreview } from './ContentForm'
import { FlowCanvas, type CreateMenuRequest, type LinkSource, type NewNodeKind } from './FlowCanvas'
import { FlowTree } from './FlowTree'
import { type FlowDoc, type PasteItem, addNode, catchAllOf, centredPositions, connectTransition, copyName, docFromFiles, docFromView, findNode, moveNodes, pasteNodes, removeNodes, removeTransition, removeTransitions, renameNode, setStartNode, unlinkTransitions, toFlowJson, toFlowView, toUiJson, uniqueNodeId, uniqueNodeName, updateCatchAll, updateNode } from './model'
import { Inspector, type ActionSection } from './Inspector'
import { FlowWidePanel } from './FlowWidePanel'
import { CreateMenu } from './CreateMenu'
import { JsonView } from './JsonView'
import { NewFlowDialog } from './NewFlowDialog'
import { toGraph } from './graph'
import { TransitionDialog } from './TransitionDialog'
import { readEdgeStyle, writeEdgeStyle, type EdgeStyle } from './edgeStyle'
import { useDrafts } from './useDrafts'
import { prettyId } from './ids'
import { FlowSaver, type SaveStatus } from './autosave'
import { type ChoiceSkillData, choiceSkillData, mergeSkillTransitions, orphanedSkillFlows, skillFlowDoc } from './skill'
import { contentIdsOf, remapContentIds, remapSkillContentIds, uniqueContentIds } from './contentCopy'
type DialogState =
  | { kind: 'none' }
  /** `nodeId` null is the flow-wide list (catchAll). */
  | { kind: 'action'; section: ActionSection; nodeId: string | null; index: number | null }
  | { kind: 'transition'; nodeId: string | null; index: number | null }
  | { kind: 'choice'; position: Point; link: LinkSource | null }
  | { kind: 'choiceEdit'; nodeId: string }
  | { kind: 'newFlow' }
  | { kind: 'renameFlow'; name: string }
  | { kind: 'duplicateFlow'; name: string }

const NO_RUN = new Set<string>()
const NO_VIEWS: FlowView[] = []
const NO_ACTIONS: ActionDef[] = []
const NO_CONTENTS: ContentElement[] = []

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}
const DEFAULT_FLOW = 'main.flow.json'
const NOTICE_MS = 4000

/** Flow editor screen: flow list, canvas or JSON view, properties or emulator panel, and autosave. */
export function FlowEditorPage() {
  const { botId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const queryClient = useQueryClient()

  const flowsQuery = useQuery({ queryKey: ['flows', botId], queryFn: () => listFlows(botId), enabled: botId !== '' })
  const actionsQuery = useQuery({ queryKey: ['actions', botId], queryFn: () => listActions(botId), enabled: botId !== '' })
  const contentQuery = useQuery({ queryKey: ['content', botId], queryFn: () => listContentElements(botId), enabled: botId !== '' })

  const views: FlowView[] = flowsQuery.data ?? NO_VIEWS
  const serverDocs = useMemo(() => Object.fromEntries(views.map((v) => [v.name, docFromView(v)])), [views])
  const drafts = useDrafts(serverDocs)
  const names = useMemo(() => views.map((v) => v.name).sort(), [views])

  const requested = params.get('flow')
  const flowName = requested && names.includes(requested) ? requested : names.includes(DEFAULT_FLOW) ? DEFAULT_FLOW : (names[0] ?? '')
  const doc = flowName ? drafts.docOf(flowName) : undefined
  const jsonView = params.get('view') === 'json'
  const emulatorOpen = params.get('emulator') === '1'

  const [selected, setSelected] = useState<string[]>([])
  const [selectRequest, setSelectRequest] = useState<string | null>(null)
 // The node whose properties are open. Opened by a click that did not move the node (never by a drag).
  const [inspectorId, setInspectorId] = useState<string | null>(null)
  const [flowWide, setFlowWide] = useState(false)
  const [menu, setMenu] = useState<CreateMenuRequest | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Flows whose overlap hint the user closed (until the page is reloaded).
  const [hintsClosed, setHintsClosed] = useState<string[]>([])
  const [edgeStyle, setEdgeStyle] = useState<EdgeStyle>(() => readEdgeStyle())
  const changeEdgeStyle = (style: EdgeStyle) => {
    writeEdgeStyle(style)
    setEdgeStyle(style)
  }
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' })
  const clipboard = useRef<PasteItem[]>([])
 // Last pointer position on the canvas (flow units): where Ctrl+V pastes.
  const pointer = useRef<Point>({ x: 100, y: 120 })
  const emu = useEmulator(botId)

  const contents: ContentElement[] = contentQuery.data ?? NO_CONTENTS
 // Quick-start chips: literal trigger texts of the bot's start nodes (main flow first).
  const triggers = useMemo(() => triggerTexts(views), [views])
  const actions: ActionDef[] = actionsQuery.data ?? NO_ACTIONS
  const contentLabels = useMemo(
    () => Object.fromEntries(contents.map((c) => [c.id, contentPreview(c.contentType, c.formData)])),
    [contents],
  )

 // Nodes on the emulator's path, highlighted green on the canvas.
  const runPath = useMemo(() => {
    if (!doc || !emulatorOpen) return NO_RUN
    const byName = new Map(doc.nodes.map((n) => [n.name, n.id]))
    return new Set(emu.stacktrace.map((name) => byName.get(name)).filter((id): id is string => Boolean(id)))
  }, [doc, emulatorOpen, emu.stacktrace])

  const graph = useMemo(
    () => (doc ? toGraph({ doc, contentLabels, runPath }) : { nodes: [], edges: [] }),
    [doc, contentLabels, runPath],
  )

  const selectedNode =
    doc && !emulatorOpen && inspectorId && selected.length === 1 && selected[0] === inspectorId ? findNode(doc, inspectorId) : undefined
  const showFlowWide = Boolean(doc && !emulatorOpen && flowWide && !selectedNode)

 // ---- Autosave (legacy FlowsAPI.updateFlow: debounced 1000ms, leading) -------------------------
  const { settle: settleDraft, drafts: draftMap } = drafts
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'saved' })
 // Drafts as the saver sees them. Settling a save updates it at once, so the saver never re-writes a saved draft.
  const mirror = useRef(draftMap)
  useEffect(() => {
    mirror.current = draftMap
  })
  const saver = useMemo(
    () =>
      new FlowSaver({
        read: (name) => mirror.current[name],
        write: (name, d) => saveFlow(botId, name, toFlowView(d)),
        settle: (name, saved) => {
          if (mirror.current[name] === saved) {
            const { [name]: _saved, ...rest } = mirror.current
            mirror.current = rest
          }
          settleDraft(name, saved)
 // A flows refetch that started before this save would land after it and put the old list back.
 // Cancel it first: the saved view below is the newer truth.
          void queryClient.cancelQueries({ queryKey: ['flows', botId] })
          queryClient.setQueryData<FlowView[]>(['flows', botId], (old) =>
            old?.map((v) => (v.name === name ? ({ ...toFlowView(saved), currentMutex: undefined } as FlowView) : v)),
          )
        },
        onStatus: setSaveStatus,
      }),
    [botId, queryClient, settleDraft],
  )
  const seenDrafts = useRef<Record<string, FlowDoc>>({})
  useEffect(() => {
    const prev = seenDrafts.current
    seenDrafts.current = draftMap
    for (const [name, d] of Object.entries(draftMap)) {
      if (prev[name] !== d) saver.changed(name)
    }
  }, [draftMap, saver])
  useEffect(() => () => saver.dispose(), [saver])

 // Leaving the page with unsaved edits asks first. Autosave runs within a second of an edit.
  const dirtyCount = drafts.dirtyNames.length
  useEffect(() => {
    if (dirtyCount === 0) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirtyCount])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const createFlowMutation = useMutation({
    mutationFn: (name: string) => createFlow(botId, newFlowView(name)),
    onSuccess: (_void, name) => {
      void queryClient.invalidateQueries({ queryKey: ['flows', botId] })
      setDialog({ kind: 'none' })
      setParams({ flow: name })
    },
  })

  const removeFlowMutation = useMutation({
    mutationFn: (name: string) => deleteFlow(botId, name),
    onSuccess: (_void, name) => {
      drafts.discard([name])
      void queryClient.invalidateQueries({ queryKey: ['flows', botId] })
      if (name === flowName) setParams({ flow: DEFAULT_FLOW })
    },
  })

  const choiceMutation = useMutation({
    mutationFn: async (args: { values: ChoiceSkillValues; position: Point; link: LinkSource | null }) => {
 // legacy insertNewSkill: the skill data gets a 10-char randomId; the file and node get a 6-char one.
      const dataId = prettyId(10)
      const flowRandomId = prettyId(6)
      const keywords = args.values.keywords
      const result = await generateChoiceFlow(botId, {
        contentId: args.values.contentId,
        invalidContentId: args.values.invalidContentId,
        keywords,
        nbMaxRetries: args.values.maxAttempts,
        randomId: dataId,
      })
      const skillFlow = `skills/choice-${flowRandomId}.flow.json`
      await createFlow(botId, toFlowView(skillFlowDoc(skillFlow, result, choiceSkillData(dataId, args.values, keywords))))
      return { ...args, flowRandomId, skillFlow, transitions: result.transitions }
    },
    onSuccess: ({ position, link, flowRandomId, skillFlow, transitions }) => {
      if (!flowName) return
 // legacy insertNewSkill: id skill-<rand>, name choice-<rand>, skill-call, empty onEnter/onReceive.
      const node: FlowNodeJson = {
        id: `skill-${flowRandomId}`,
        name: `choice-${flowRandomId}`,
        type: 'skill-call',
        skill: 'choice',
        flow: skillFlow,
        onEnter: null,
        onReceive: null,
 // Transitions as generated: captions set, targets empty until the user links them.
        next: transitions,
      }
      placeNode(node, position, link)
      setDialog({ kind: 'none' })
      void queryClient.invalidateQueries({ queryKey: ['flows', botId] })
    },
  })

  /** Regenerates the skill flow of an existing choice node (legacy updateSkill): same skill file, transitions keep their targets. */
  const editChoiceMutation = useMutation({
    mutationFn: async (args: { nodeId: string; skillFlow: string; values: ChoiceSkillValues }) => {
      const current = drafts.docOf(args.skillFlow)
      const previous = current?.meta.skillData as ChoiceSkillData | undefined
      const randomId = previous?.randomId ?? prettyId(10)
      const keywords = args.values.keywords
      const result = await generateChoiceFlow(botId, {
        contentId: args.values.contentId,
        invalidContentId: args.values.invalidContentId,
        keywords,
        nbMaxRetries: args.values.maxAttempts,
        randomId,
      })
      return { ...args, result, skillData: choiceSkillData(randomId, args.values, keywords), positions: current?.positions ?? {} }
    },
    onSuccess: ({ nodeId, skillFlow, result, skillData, positions }) => {
      if (!flowName) return
      const generated = skillFlowDoc(skillFlow, result, skillData, positions)
      drafts.edit(skillFlow, (d) => ({ ...generated, meta: { ...d.meta, ...generated.meta } }))
      drafts.edit(flowName, (d) =>
        updateNode(d, nodeId, (n) => ({ ...n, next: mergeSkillTransitions(n.next, result.transitions) })),
      )
      setDialog({ kind: 'none' })
    },
  })

  const renameFlowMutation = useMutation({
    mutationFn: async ({ from, to }: { from: string; to: string }) => {
      await saver.flush([from])
      const current = drafts.docOf(from)
      if (!current) throw new Error(`${from} is not loaded`)
      await saveFlow(botId, from, toFlowView({ ...current, name: to }))
      return { from, to }
    },
    onSuccess: ({ from, to }) => {
 // Skill nodes that point at the old file follow the rename (autosaved like any other edit).
      for (const other of names) {
        if (other === from) continue
        const od = drafts.docOf(other)
        if (od?.nodes.some((n) => n.flow === from)) {
          drafts.edit(other, (d) => ({ ...d, nodes: d.nodes.map((n) => (n.flow === from ? { ...n, flow: to } : n)) }))
        }
      }
      drafts.discard([from])
      void queryClient.invalidateQueries({ queryKey: ['flows', botId] })
      setDialog({ kind: 'none' })
      if (flowName === from) setParams({ flow: to })
    },
  })

  const duplicateFlowMutation = useMutation({
    mutationFn: async ({ from, to }: { from: string; to: string }) => {
      await saver.flush([from])
      const current = drafts.docOf(from)
      if (!current) throw new Error(`${from} is not loaded`)
      await createFlow(botId, toFlowView({ ...current, name: to }))
      return to
    },
    onSuccess: (to) => {
      void queryClient.invalidateQueries({ queryKey: ['flows', botId] })
      setDialog({ kind: 'none' })
      setParams({ flow: to })
    },
  })

  /** Places a node at `position`, linking it to the port it was dragged from if any. */
  function placeNode(node: FlowNodeJson, position: Point, link: LinkSource | null) {
    if (!flowName) return
    drafts.edit(flowName, (d) => {
      const next = addNode(d, node, position)
      if (!link) return next
 // Out port: the port's transition now goes to the new node. In port: the new node's first transition goes to the source.
      if (link.side === 'out') return connectTransition(next, link.nodeId, link.index, node.name)
      const source = findNode(next, link.nodeId)
      return source ? connectTransition(next, node.id, 0, source.name) : next
    })
    setSelected([node.id])
    setSelectRequest(node.id)
    setInspectorId(node.id)
    setFlowWide(false)
  }

  function createStandard(position: Point, link: LinkSource | null) {
    if (!doc) return
    const id = prettyId(10)
    const name = uniqueNodeName(doc, `node-${prettyId(4)}`)
 // legacy createFlowNode defaults: type standard, onEnter [], onReceive null (no wait), one open transition.
    placeNode({ id, name, type: 'standard', onEnter: [], onReceive: null, next: [{ condition: 'true', node: '' }] }, position, link)
  }

  /** Deletes nodes (legacy removeFlowNode): the start node stays, skill flows no node uses any more are deleted. */
  function deleteNodes(ids: string[]) {
    if (!doc || !flowName) return
    const startName = doc.meta.startNode
    const blocked = doc.nodes.some((n) => ids.includes(n.id) && n.name === startName)
    const removed = new Set(ids.filter((id) => findNode(doc, id)?.name !== startName))
    if (blocked) setNotice("You can't delete the start node.")
    if (removed.size === 0) return
    const everything = Object.fromEntries(names.map((n) => [n, drafts.docOf(n)]).filter((e): e is [string, FlowDoc] => e[1] !== undefined))
    const orphans = doc.nodes
      .filter((n) => removed.has(n.id) && n.type === 'skill-call' && n.flow)
      .map((n) => n.flow as string)
      .filter((flow) => orphanedSkillFlows(everything, flow, removed, flowName))
    editDoc((d) => removeNodes(d, removed))
    setSelected([])
    setInspectorId(null)
    if (orphans.length > 0) void deleteSkillFlows(flowName, [...new Set(orphans)])
  }

  /** Writes the parent flow first (legacy order), then deletes the skill flow files. */
  async function deleteSkillFlows(parent: string, flows: string[]) {
    await saver.flush([parent])
    for (const name of flows) await deleteFlow(botId, name)
    drafts.discard(flows)
    void queryClient.invalidateQueries({ queryKey: ['flows', botId] })
  }

  /** Pastes the clipboard centred on `at` in flow `name` (legacy requestPasteFlowNode + pasteFlowNode for skills). */
  async function pasteAt(name: string, at: Point) {
    const items = clipboard.current
    if (items.length === 0) return
    const skillOf = (item: PasteItem) => (item.node.flow ? (drafts.docOf(item.node.flow)?.meta.skillData as ChoiceSkillData | undefined) : undefined)
 // Owner decision (2026-11-11): the paste owns its content. Each element the copied nodes refer to is
 // duplicated once (same type and formData, new id) and the copies point at the duplicates, so editing
 // the copy never changes the original. Duplicates are created before the nodes that name them.
    const refs = uniqueContentIds(items.flatMap((i) => contentIdsOf(i.node, i.node.type === 'skill-call' ? skillOf(i) : undefined)))
    const copies = new Map<string, string>()
 // Read fresh: an element created a moment ago may not be in the loaded list yet.
    const known = refs.length > 0 ? await listContentElements(botId) : []
    for (const oldId of refs) {
      const element = known.find((c) => c.id === oldId)
      if (!element) continue
      copies.set(oldId, await saveContentElement(botId, element.contentType, null, structuredClone(element.formData)))
    }
    if (copies.size > 0) void queryClient.invalidateQueries({ queryKey: ['content', botId] })
    const copied = items.map((i) => ({ ...i, node: remapContentIds(i.node, copies) }))
    const plain = copied.filter((i) => i.node.type !== 'skill-call')
    const skills = copied.filter((i) => i.node.type === 'skill-call')
    const placed = centredPositions(items, at)
    const ids: string[] = []
    if (plain.length > 0) {
 // Computed inside the updater: two quick pastes must see each other's copies (copy names).
      let pasted: string[] = []
      drafts.edit(name, (d) => {
        const result = pasteNodes(d, plain, at, () => prettyId(10))
        pasted = result.newIds
        return result.doc
      })
      ids.push(...pasted)
    }
    for (const item of skills) {
      const index = copied.indexOf(item)
      const original = skillOf(items[index])
      if (!original) continue
      const source = remapSkillContentIds(original, copies)
 // A pasted choice gets its own skill flow with a new randomId, like legacy.
      const randomId = prettyId(10)
      const result = await generateChoiceFlow(botId, {
        contentId: source.contentId,
        invalidContentId: source.invalidContentId || undefined,
        keywords: source.keywords,
        nbMaxRetries: source.config.nbMaxRetries,
        randomId,
      })
      const flowRandomId = prettyId(6)
      const skillFlow = `skills/choice-${flowRandomId}.flow.json`
      await createFlow(botId, toFlowView(skillFlowDoc(skillFlow, result, { ...source, randomId })))
      const position = placed[index]
      const id = `skill-${flowRandomId}`
      drafts.edit(name, (d) => {
        const node: FlowNodeJson = {
          id: uniqueNodeId(d, id),
          name: copyName(d.nodes.map((n) => n.name), item.node.name),
          type: 'skill-call',
          skill: item.node.skill,
          flow: skillFlow,
          onEnter: null,
          onReceive: null,
          next: result.transitions,
        }
        ids.push(node.id)
        return addNode(d, node, position)
      })
    }
    void queryClient.invalidateQueries({ queryKey: ['flows', botId] })
    if (ids.length > 0) {
 // Like every creation (legacy currentFlowNode): the first pasted node is selected and its properties open.
      setSelected(ids)
      setSelectRequest(ids[0])
      setInspectorId(ids[0])
      setFlowWide(false)
    }
  }

 // Keyboard: save, undo/redo, copy/paste, emulator toggle. Ignored while typing in a field.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey
      if (!mod || !flowName) return
      const key = event.key.toLowerCase()
      if (key === 's') {
        event.preventDefault()
        void saver.flush(Object.keys(mirror.current))
        return
      }
      if (isTyping(event.target)) return
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault()
        drafts.undo(flowName)
      } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
        event.preventDefault()
        drafts.redo(flowName)
      } else if (key === 'c' && doc) {
        clipboard.current = selected
          .map((id) => findNode(doc, id))
          .filter((n): n is FlowNodeJson => n !== undefined)
          .map((n) => ({ node: structuredClone(n), position: doc.positions[n.id] ?? { x: 0, y: 0 } }))
      } else if (key === 'v' && clipboard.current.length > 0) {
        event.preventDefault()
        void pasteAt(flowName, pointer.current)
      } else if (key === 'e') {
        event.preventDefault()
        setFlowParam(setParams, 'emulator', emulatorOpen ? null : '1')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!botId) return null

  const editDoc = (change: (d: FlowDoc) => FlowDoc) => {
    if (flowName) drafts.edit(flowName, change)
  }

  const catchAll: CatchAll = doc ? catchAllOf(doc) : { onReceive: [], next: [] }
  const targetNode = dialog.kind === 'action' || dialog.kind === 'transition' ? (dialog.nodeId && doc ? findNode(doc, dialog.nodeId) : undefined) : undefined
  const transitionList = dialog.kind === 'transition' ? (dialog.nodeId === null ? catchAll.next : targetNode?.next ?? []) : []
  const transitionInitial = dialog.kind === 'transition' && dialog.index !== null ? (transitionList[dialog.index] ?? null) : null
  const actionInitial =
    dialog.kind === 'action' && dialog.index !== null
      ? (dialog.nodeId === null
          ? catchAll.onReceive
          : (dialog.section === 'onEnter' ? targetNode?.onEnter : targetNode?.onReceive))?.[dialog.index] ?? null
      : null

  const choiceEditNode = dialog.kind === 'choiceEdit' && doc ? findNode(doc, dialog.nodeId) : undefined
  const choiceEditData = choiceEditNode?.flow ? (drafts.docOf(choiceEditNode.flow)?.meta.skillData as ChoiceSkillData | undefined) : undefined
  const choiceEditInitial: ChoiceSkillValues | undefined =
    dialog.kind === 'choiceEdit'
      ? { contentId: choiceEditData?.contentId ?? '', invalidContentId: choiceEditData?.invalidContentId ?? '', maxAttempts: choiceEditData?.config?.nbMaxRetries ?? 3, keywords: choiceEditData?.keywords ?? {} }
      : undefined

  const nodeCount = doc?.nodes.length ?? 0
  const dirty = drafts.dirtyNames.length > 0
  const saveFailed = saveStatus.kind === 'error'
  const saving = !saveFailed && (dirty || saveStatus.kind === 'saving')
  const statusLabel = saveFailed ? 'Save failed' : saving ? 'Saving...' : 'Saved'
  const statusDot = saveFailed ? 'bg-red' : saving ? 'bg-amber' : 'bg-green'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Topbar
        crumbs={[botId, flowName || '...']}
        status={
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn('size-1.5 rounded-full', statusDot)} />
            {statusLabel}
          </span>
        }
        actions={
          <>
            <Button variant="ghost" size="icon-sm" aria-label="Undo" disabled={!flowName || !drafts.canUndo(flowName)} onClick={() => drafts.undo(flowName)}>
              <Undo2 />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Redo" disabled={!flowName || !drafts.canRedo(flowName)} onClick={() => drafts.redo(flowName)}>
              <Redo2 />
            </Button>
            <span className="mx-1 h-5 w-px bg-border" />
            <div className="flex h-[30px] items-center gap-0.5 rounded-[7px] bg-muted p-[3px]">
              <SegmentButton active={!jsonView} onClick={() => setFlowParam(setParams, 'view', null)} icon={<Workflow className="size-3.5" />} label="Visual" />
              <SegmentButton active={jsonView} onClick={() => setFlowParam(setParams, 'view', 'json')} icon={<Braces className="size-3.5" />} label="JSON" />
            </div>
            <span className="mx-1 h-5 w-px bg-border" />
            <Button variant={emulatorOpen ? 'default' : 'outline'} onClick={() => setFlowParam(setParams, 'emulator', emulatorOpen ? null : '1')}>
              <MessageSquare /> Emulator
            </Button>
            <Button
              variant={dirty || saveFailed ? 'default' : 'outline'}
              disabled={(!dirty && !saveFailed) || saveStatus.kind === 'saving'}
              onClick={() => void saver.flush(Object.keys(mirror.current))}
            >
              <Save /> {saveFailed ? 'Retry save' : 'Save'}
            </Button>
          </>
        }
      />
      {saveFailed && (
        <div role="alert" className="border-b border-border bg-red/5 px-3 py-1.5 text-xs text-red">
          Save failed: {saveStatus.message}. Your edits are kept. Press Retry save.
        </div>
      )}
      {notice && (
        <div role="status" className="border-b border-border bg-amber/10 px-3 py-1.5 text-xs text-foreground">
          {notice}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <Rail active="flow" />
        <FlowTree
          names={names}
          activeName={flowName}
          dirtyNames={new Set(drafts.dirtyNames)}
          onSelect={(name) => {
            setSelected([])
            setInspectorId(null)
            setFlowWide(false)
            setParams({ flow: name, ...(jsonView ? { view: 'json' } : {}) })
          }}
          onNew={() => setDialog({ kind: 'newFlow' })}
          onRename={(name) => setDialog({ kind: 'renameFlow', name })}
          onDuplicate={(name) => setDialog({ kind: 'duplicateFlow', name })}
          onDelete={(name) => {
            if (window.confirm(`Delete ${name}? This also removes its layout file.`)) removeFlowMutation.mutate(name)
          }}
        />

        <main className="relative flex min-w-0 flex-1 flex-col bg-canvas">
          {flowsQuery.isError && <p role="alert" className="p-4 text-red">{flowsQuery.error.message}</p>}
          {!doc && flowsQuery.isPending && <p className="p-4 text-muted-foreground">Loading flows...</p>}
          {doc && jsonView && (
            <JsonView
              key={`${flowName}-json`}
              name={flowName}
              json={JSON.stringify(toFlowJson(doc), null, 2)}
              onApply={(flow: FlowJson) => editDoc((d) => docFromFiles(d.name, flow, toUiJson(d)))}
            />
          )}
          {doc && !jsonView && (
            <>
              <button
                type="button"
                onClick={() => {
                  setFlowWide(true)
                  setInspectorId(null)
                  setSelected([])
                }}
                className="absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm hover:text-foreground"
              >
                {catchAll.next.length} flow-wide {catchAll.next.length === 1 ? 'transition' : 'transitions'}
                {'  /  '}
                {(catchAll.onReceive ?? []).length} flow-wide on {(catchAll.onReceive ?? []).length === 1 ? 'receive' : 'receives'}
              </button>
              <FlowCanvas
                nodes={graph.nodes}
                edges={graph.edges}
                selectRequest={selectRequest}
                edgeStyle={edgeStyle}
                onEdgeStyleChange={changeEdgeStyle}
                onSelectRequestDone={() => setSelectRequest(null)}
                hintDismissed={hintsClosed.includes(flowName)}
                onDismissHint={() => setHintsClosed((closed) => [...closed, flowName])}
                handlers={{
                  onNotice: (text) => setNotice(text),
                  removeTransition: (nodeId, index) => editDoc((d) => removeTransition(d, nodeId, index)),
                  editTransition: (nodeId, index) => setDialog({ kind: 'transition', nodeId, index }),
                  onSelect: (ids) => setSelected((prev) => (sameIds(prev, ids) ? prev : ids)),
                  onOpenNode: (id) => {
                    setInspectorId(id)
                    setFlowWide(false)
                  },
                  onEditNode: (id) => {
                    const node = findNode(doc, id)
                    if (node?.type === 'skill-call' && node.skill === 'choice') setDialog({ kind: 'choiceEdit', nodeId: id })
                    else {
                      setInspectorId(id)
                      setFlowWide(false)
                    }
                  },
                  onMove: (positions) => editDoc((d) => moveNodes(d, positions)),
                  onConnect: (sourceId, index, targetId) => {
                    const target = findNode(doc, targetId)
                    if (target) editDoc((d) => connectTransition(d, sourceId, index, target.name))
                  },
                  onDropNode: (kind: NewNodeKind, position) => {
                    if (kind === 'choice') setDialog({ kind: 'choice', position, link: null })
                    else createStandard(position, null)
                  },
                  onDeleteNodes: deleteNodes,
 // Backspace on a selected link unlinks it: the transition (its condition and port) stays, as in legacy.
                  onDeleteEdges: (refs) => {
                    editDoc((d) => unlinkTransitions(d, refs))
                  },
                  onOpenCreateMenu: (request) => setMenu(request),
                  onPointer: (p) => {
                    pointer.current = p
                  },
                  onPaneClick: () => {
                    setMenu(null)
                    setInspectorId(null)
                    setFlowWide(false)
                  },
                }}
              />
            </>
          )}
          {menu && flowName && (
            <CreateMenu
              at={menu.screen}
              canPaste={clipboard.current.length > 0}
              onClose={() => setMenu(null)}
              onPaste={() => {
                void pasteAt(flowName, menu.flow)
                setMenu(null)
              }}
              onStandard={() => {
                createStandard(menu.flow, menu.link)
                setMenu(null)
              }}
              onChoice={() => {
                setDialog({ kind: 'choice', position: menu.flow, link: menu.link })
                setMenu(null)
              }}
            />
          )}
        </main>

        {selectedNode && (
          <Inspector
            node={selectedNode}
            isStart={doc?.meta.startNode === selectedNode.name}
            contentLabels={contentLabels}
            onRename={(name) => {
              if (doc?.nodes.some((n) => n.id !== selectedNode.id && n.name === name)) return
              editDoc((d) => renameNode(d, selectedNode.id, name))
            }}
            onSetStart={() => editDoc((d) => setStartNode(d, selectedNode.id))}
            onToggleWait={(on) => editDoc((d) => updateNode(d, selectedNode.id, (n) => ({ ...n, onReceive: on ? [] : null })))}
            onEditAction={(section, index) => setDialog({ kind: 'action', section, nodeId: selectedNode.id, index })}
            onRemoveAction={(section, index) =>
              editDoc((d) =>
                updateNode(d, selectedNode.id, (n) => ({ ...n, [section]: (n[section] ?? []).filter((_, i) => i !== index) })),
              )
            }
            onEditTransition={(index) => setDialog({ kind: 'transition', nodeId: selectedNode.id, index })}
            onRemoveTransition={(index) => editDoc((d) => removeTransitions(d, [{ nodeId: selectedNode.id, index }]))}
            onClose={() => setInspectorId(null)}
          />
        )}
        {showFlowWide && (
          <FlowWidePanel
            catchAll={catchAll}
            contentLabels={contentLabels}
            onEditAction={(section, index) => setDialog({ kind: 'action', section, nodeId: null, index })}
            onRemoveAction={(_section, index) =>
              editDoc((d) => updateCatchAll(d, (c) => ({ ...c, onReceive: (c.onReceive ?? []).filter((_, i) => i !== index) })))
            }
            onEditTransition={(index) => setDialog({ kind: 'transition', nodeId: null, index })}
            onRemoveTransition={(index) => editDoc((d) => updateCatchAll(d, (c) => ({ ...c, next: c.next.filter((_, i) => i !== index) })))}
            onClose={() => setFlowWide(false)}
          />
        )}
        {emulatorOpen && <EmulatorPanel emu={emu} botId={botId} triggers={triggers} onClose={() => setFlowParam(setParams, 'emulator', null)} />}
      </div>

      <footer className="flex h-[26px] shrink-0 items-center justify-between border-t border-border bg-background px-3 text-[11px] text-muted-foreground">
        <span>{botId}  ·  {flowName}  ·  {nodeCount} nodes{selected.length ? `  ·  ${selected.length} selected` : ''}</span>
        <span>Emulator  Ctrl+E</span>
      </footer>

      {doc && (
        <ActionDialog
          key={dialog.kind === 'action' ? `a-${dialog.nodeId}-${dialog.section}-${dialog.index}` : 'a'}
          open={dialog.kind === 'action'}
          onOpenChange={(open) => !open && setDialog({ kind: 'none' })}
          botId={botId}
          section={dialog.kind === 'action' && dialog.section === 'onReceive' ? 'On receive' : 'On enter'}
          initial={actionInitial}
          actions={actions}
          contents={contents}
          onSubmit={(raw) => {
            if (dialog.kind !== 'action') return
            const { section, nodeId, index } = dialog
            const apply = (list: string[]) => {
              const next = [...list]
              if (index === null) next.push(raw)
              else next[index] = raw
              return next
            }
 // Flow-wide has only on receive actions (legacy catchAll).
            if (nodeId === null) {
              editDoc((d) => updateCatchAll(d, (c) => ({ ...c, onReceive: apply(c.onReceive ?? []) })))
              return
            }
            editDoc((d) =>
              updateNode(d, nodeId, (n) => ({ ...n, [section]: apply(n[section] ?? []) })),
            )
          }}
        />
      )}
      {doc && dialog.kind === 'transition' && (
        <TransitionDialog
          key={`t-${dialog.nodeId ?? 'flow'}-${dialog.index}`}
          open
          onOpenChange={(open) => !open && setDialog({ kind: 'none' })}
          initial={transitionInitial}
          nodeNames={doc.nodes.map((n) => n.name)}
          flowNames={names}
          onSubmit={(t: Transition) => {
            const { nodeId, index } = dialog
            const apply = (list: Transition[]) => (index === null ? [...list, t] : list.map((x, i) => (i === index ? t : x)))
            if (nodeId === null) editDoc((d) => updateCatchAll(d, (c) => ({ ...c, next: apply(c.next) })))
            else editDoc((d) => updateNode(d, nodeId, (n) => ({ ...n, next: apply(n.next) })))
          }}
        />
      )}
      {dialog.kind === 'choice' && (
        <ChoiceSkillDialog
          open
          onOpenChange={(open) => !open && setDialog({ kind: 'none' })}
          contents={contents}
          busy={choiceMutation.isPending}
          error={choiceMutation.isError ? choiceMutation.error.message : null}
          onSubmit={(values) => choiceMutation.mutate({ values, position: dialog.position, link: dialog.link })}
        />
      )}
      {dialog.kind === 'choiceEdit' && choiceEditNode?.flow && choiceEditInitial && (
        <ChoiceSkillDialog
          open
          onOpenChange={(open) => !open && setDialog({ kind: 'none' })}
          contents={contents}
          initial={choiceEditInitial}
          busy={editChoiceMutation.isPending}
          error={editChoiceMutation.isError ? editChoiceMutation.error.message : null}
          onSubmit={(values) => editChoiceMutation.mutate({ nodeId: dialog.nodeId, skillFlow: choiceEditNode.flow as string, values })}
        />
      )}
      {dialog.kind === 'newFlow' && (
        <NewFlowDialog
          open
          onOpenChange={(open) => !open && setDialog({ kind: 'none' })}
          existing={names}
          busy={createFlowMutation.isPending}
          error={createFlowMutation.isError ? createFlowMutation.error.message : null}
          onSubmit={(name) => createFlowMutation.mutate(name)}
        />
      )}
      {dialog.kind === 'renameFlow' && (
        <NewFlowDialog
          open
          onOpenChange={(open) => !open && setDialog({ kind: 'none' })}
          existing={names}
          title="Rename flow"
          description="Renames the flow file. Skill nodes that use it follow the new name."
          initialName={dialog.name}
          submitLabel="Rename"
          busy={renameFlowMutation.isPending}
          error={renameFlowMutation.isError ? renameFlowMutation.error.message : null}
          onSubmit={(to) => renameFlowMutation.mutate({ from: dialog.name, to })}
        />
      )}
      {dialog.kind === 'duplicateFlow' && (
        <NewFlowDialog
          open
          onOpenChange={(open) => !open && setDialog({ kind: 'none' })}
          existing={names}
          title="Duplicate flow"
          description="Copies the flow, its nodes and its layout into a new file."
          initialName={`${dialog.name.replace(/\.flow\.json$/, '')}-copy`}
          submitLabel="Duplicate"
          busy={duplicateFlowMutation.isPending}
          error={duplicateFlowMutation.isError ? duplicateFlowMutation.error.message : null}
          onSubmit={(to) => duplicateFlowMutation.mutate({ from: dialog.name, to })}
        />
      )}
    </div>
  )
}

function SegmentButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-6 items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium',
        active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function newFlowView(name: string): FlowView {
  return {
    version: '0.0.1',
    catchAll: { onReceive: [], next: [] },
    startNode: 'entry',
    name,
    location: name,
    nodes: [{ id: 'entry', name: 'entry', onEnter: [], onReceive: null, next: [], x: 100, y: 120 }],
    links: [],
  }
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

function setFlowParam(
  setParams: ReturnType<typeof useSearchParams>[1],
  key: string,
  value: string | null,
): void {
  setParams((prev) => {
    const next = new URLSearchParams(prev)
    if (value === null) next.delete(key)
    else next.set(key, value)
    return next
  })
}

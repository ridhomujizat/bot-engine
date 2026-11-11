import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

// Shared pieces of the legacy vs bot-engine parity runner (docs/editor-parity.md). Everything here is
// plain HTTP or pure functions; the two UI drivers live in and 

export const LEGACY_URL = process.env.LEGACY_URL ?? ''
export const OURS_URL = process.env.OURS_URL ?? ''
export const LEGACY_EMAIL = process.env.LEGACY_EMAIL ?? ''
export const LEGACY_PASSWORD = process.env.LEGACY_PASSWORD ?? ''
export const OURS_EMAIL = process.env.OURS_EMAIL ?? ''
export const OURS_PASSWORD = process.env.OURS_PASSWORD ?? ''
export const BOT_TGZ = process.env.BOT_TGZ ?? ''
export const BOT_ID = process.env.PARITY_BOT_ID ?? 'example-bot'

/** The runner needs both servers, both logins and the archive. Otherwise every test skips. */
export const PARITY_ENABLED = Boolean(LEGACY_URL && OURS_URL && LEGACY_EMAIL && LEGACY_PASSWORD && OURS_EMAIL && OURS_PASSWORD && BOT_TGZ)

export interface Session {
  base: string
  jwt: string
  /** Token expiry and issue time, as the legacy UI stores them in bp/token. */
  exp: number
  iat: number
}

/** Logs in through the same endpoint the UI uses. */
export async function login(base: string, email: string, password: string): Promise<Session> {
  const res = await fetch(`${base}/api/v1/auth/login/basic/default`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(`login ${base}: ${res.status}`)
  const jwt = ((await res.json()) as { payload: { jwt: string } }).payload.jwt
  const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()) as { exp: number; iat: number }
  return { base, jwt, exp: claims.exp, iat: claims.iat }
}

/** Re-imports the archive as the bot, overwriting it: every scenario starts from the same bot. */
export async function resetBot(s: Session): Promise<void> {
  const archive = readFileSync(BOT_TGZ)
  const res = await fetch(`${s.base}/api/v1/admin/workspace/bots/${BOT_ID}/import?overwrite=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.jwt}`, 'Content-Type': 'application/tar+gzip' },
    body: archive,
  })
  if (!res.ok) throw new Error(`import ${s.base}: ${res.status} ${await res.text()}`)
}

/** Flow JSON as the studio API serves it (same route on both servers). */
export async function fetchFlows(s: Session): Promise<Flow[]> {
  const res = await fetch(`${s.base}/api/v1/studio/${BOT_ID}/flows`, { headers: { Authorization: `Bearer ${s.jwt}` } })
  if (!res.ok) throw new Error(`flows ${s.base}: ${res.status}`)
  return (await res.json()) as Flow[]
}

/** Content elements (the CMS list), for the scenarios that create text or questions. */
export async function fetchContents(s: Session): Promise<unknown> {
  const res = await fetch(`${s.base}/api/v1/studio/${BOT_ID}/cms/elements`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 1000, from: 0 }),
  })
  if (!res.ok) throw new Error(`cms ${s.base}: ${res.status}`)
  return res.json()
}

export interface FlowNode {
  id: string
  name: string
  type?: string
  skill?: string
  flow?: string
  x?: number
  y?: number
  onEnter?: unknown
  onReceive?: unknown
  next: { condition: string; node: string; conditionType?: string; caption?: string }[]
}

export interface Flow {
  name: string
  startNode: string
  nodes: FlowNode[]
  links?: { source: string; sourcePort: string; target: string; points?: unknown }[]
  catchAll?: unknown
  skillData?: unknown
  [k: string]: unknown
}

/** Keys that are runtime state, not saved structure. legacy adds currentMutex when a flow is open. */
const RUNTIME_KEYS = new Set(['currentMutex', 'location'])

/**
 * Structure of a flow set, with generated ids and names replaced by placeholders.
 *
 * Kept as-is: flow names, fixture node ids and names (those present before the scenario), node
 * types, conditions, actions, captions, catchAll, skill data except the random id, transitions.
 * Replaced by placeholders: any node id or name the scenario created (numbered in order of first
 * appearance, so two editors that create the same nodes in the same order compare equal), any
 * skill file name created in the scenario, random skill and content ids, link routing points
 * (layout, not structure), and the x/y of new nodes (drop coordinates depend on each canvas zoom;
 * the grid check is done separately by the scenario).
 */
export function normalize(flows: Flow[], fixture: { ids: Set<string>; names: Set<string>; flows: Set<string> }, layoutOnly: ReadonlySet<string> = new Set()): unknown {
  const ids = new Map<string, string>()
  const names = new Map<string, string>()
  const files = new Map<string, string>()
  const label = (map: Map<string, string>, value: string, prefix: string) => {
    let out = map.get(value)
    if (!out) {
      out = `${prefix}${map.size + 1}`
      map.set(value, out)
    }
    return out
  }
  const isGenNode = (n: FlowNode) => !fixture.ids.has(n.id)
  const sorted = [...flows].sort((a, b) => a.name.localeCompare(b.name))
 // Walk in one fixed order so placeholders are numbered the same on both sides.
  for (const f of sorted) for (const n of f.nodes) if (isGenNode(n)) label(ids, n.id, 'id')
  for (const f of sorted) for (const n of f.nodes) if (isGenNode(n)) label(names, n.name, 'node')
  for (const f of sorted) if (!fixture.flows.has(f.name)) label(files, f.name, 'flow')

  const mapName = (name: string) => (names.has(name) ? names.get(name)! : name)
  const mapId = (id: string) => (ids.has(id) ? ids.get(id)! : id)
 // A skill's randomId (skillData.randomId, 10 random chars) is generated per insert and also appears
 // inside action strings and conditions of the skill and of its parent flow, e.g. "skill-choice-ret-<id>".
 // Every occurrence becomes <rid>. Known gap: this would hide a string that names a different id than
 // its own skillData; the skillData.randomId itself is still compared (as <rand>, so only its presence).
  const randomIds = [...new Set(flows.flatMap((f) => { const r = (f.skillData as { randomId?: unknown } | undefined)?.randomId; return typeof r === 'string' && r ? [r] : [] }))]
 // Random 6-char and 10-char tokens inside action strings, e.g. "#!builtin_text-aLG3CW".
  const scrubTokens = (s: string) => {
 // Content ids are 6 random characters from [A-Za-z0-9_-] (legacy ids can contain a hyphen, e.g. builtin_text-B9-Fem).
    let out = s.replace(/(builtin_[a-z-]+?)-[A-Za-z0-9_-]{6}(?![A-Za-z0-9_-])/g, '$1-<rand>')
    for (const r of randomIds) out = out.split(r).join('<rid>')
    return out
  }

  const scrub = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') {
      if (key === 'id' || key === 'source' || key === 'target' || key === 'sourceId') return mapId(value)
      if (key === 'node' || key === 'startNode' || key === 'name' || key === 'sourceNode' || key === 'nodeName') return mapName(value)
      if (key === 'flow' || key === 'location') return files.get(value) ?? value
      if (key === 'randomId') return '<rand>'
      return scrubTokens(value)
    }
    if (Array.isArray(value)) return value.map((v) => scrub(v, key))
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (RUNTIME_KEYS.has(k)) continue
        if (k === 'points') continue
        out[k] = scrub(v, k)
      }
      return out
    }
    return value
  }

  return sorted.map((f) => {
    const flow = scrub({ ...f, name: files.get(f.name) ?? f.name }) as Record<string, unknown>
 // ui links are a set: the order legacy writes them in follows its diagram model, not the flow. Compared sorted.
    if (Array.isArray(flow.links)) {
      flow.links = [...(flow.links as unknown[])].sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1))
    }
 // Generated node coordinates: keep the grid check, drop the value. Fixture nodes keep theirs.
    flow.nodes = (f.nodes as FlowNode[]).map((n, i) => {
      const scrubbed = (flow.nodes as Record<string, unknown>[])[i]
 // Moved fixture nodes: the value is checked on the grid by the scenario, not compared (see dragNodeBy).
      if (layoutOnly.has(n.name)) {
        const { x: _lx, y: _ly, ...rest } = scrubbed
        return rest
      }
      if (!isGenNode(n)) return scrubbed
      const { x: _x, y: _y, ...rest } = scrubbed
      return rest
    })
    return flow
  })
}

/** Grid check for nodes created by a scenario: legacy stores drops and drags on the 5-unit grid. */
export function gridViolations(flows: Flow[], fixture: { ids: Set<string> }): string[] {
  const bad: string[] = []
  for (const f of flows) {
    for (const n of f.nodes) {
      if (fixture.ids.has(n.id)) continue
      if (n.x === undefined || n.y === undefined) continue
      if (!Number.isInteger(n.x) || !Number.isInteger(n.y) || n.x % 5 !== 0 || n.y % 5 !== 0) bad.push(`${f.name} ${n.name}: ${n.x},${n.y}`)
    }
  }
  return bad
}

/**
 * Moves a node on screen by a pixel offset, then corrects the leftover: a drag that starts on a
 * node loses a few pixels to the editor's drag threshold, so a second short drag closes the gap.
 * The grid snap is applied by the editor after the drag, so the caller compares saved positions.
 */
export async function dragNodeBy(page: { mouse: { move(x: number, y: number, o?: { steps?: number }): Promise<void>; down(): Promise<void>; up(): Promise<void> } }, box: () => Promise<{ x: number; y: number } | null>, start: { x: number; y: number }, dxPx: number, dyPx: number) {
  const from = { ...start }
  let before = await box()
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    const steps = 10
    for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + (dxPx * i) / steps, from.y + (dyPx * i) / steps)
    await page.mouse.up()
    await new Promise((r) => setTimeout(r, 400))
    const after = await box()
    if (!before || !after) return
    const movedX = after.x - before.x
    const movedY = after.y - before.y
    const residualX = dxPx - movedX
    const residualY = dyPx - movedY
    if (Math.abs(residualX) < 1 && Math.abs(residualY) < 1) return
 // Next pass: drag the leftover from the node's new place.
    before = after
    from.x += movedX
    from.y += movedY
    dxPx = residualX
    dyPx = residualY
  }
}

/** Structural diff of two JSON values: one line per differing path. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- arbitrary JSON from two servers
export function diffJson(a: any, b: any, path = '$', out: string[] = []): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return out
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length)
    for (let i = 0; i < n; i++) {
      if (i >= a.length) out.push(`${path}[${i}]: only in ours: ${JSON.stringify(b[i])}`)
      else if (i >= b.length) out.push(`${path}[${i}]: only in legacy: ${JSON.stringify(a[i])}`)
      else diffJson(a[i], b[i], `${path}[${i}]`, out)
    }
    return out
  }
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of [...keys].sort()) {
      if (!(k in b)) out.push(`${path}.${k}: only in legacy: ${JSON.stringify(a[k])}`)
      else if (!(k in a)) out.push(`${path}.${k}: only in ours: ${JSON.stringify(b[k])}`)
      else diffJson(a[k], b[k], `${path}.${k}`, out)
    }
    return out
  }
  out.push(`${path}: legacy=${JSON.stringify(a)} ours=${JSON.stringify(b)}`)
  return out
}

export interface ContentElement {
  id: string
  contentType: string
  formData: unknown
  [k: string]: unknown
}

/** The CMS list as an array (the endpoint answers with the list, or with an object holding it). */
export function contentList(x: unknown): ContentElement[] {
  if (Array.isArray(x)) return x as ContentElement[]
  return ((x as { elements?: unknown[] }).elements ?? []) as ContentElement[]
}

/**
 * What a scenario changed in the content elements: elements that did not exist before (type and
 * formData only; ids and dates are generated and ignored) and existing elements whose formData changed.
 */
export function contentDelta(before: unknown, after: unknown) {
  const b = contentList(before)
  const a = contentList(after)
  const beforeById = new Map(b.map((c) => [c.id, c]))
  const added = a
    .filter((c) => !beforeById.has(c.id))
    .map((c) => ({ contentType: c.contentType, formData: c.formData }))
    .sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1))
  const changed = a
    .filter((c) => beforeById.has(c.id) && JSON.stringify(c.formData) !== JSON.stringify(beforeById.get(c.id)!.formData))
    .map((c) => c.id)
    .sort()
  return { added, changed }
}

/**
 * Exports the whole bot (`GET.../bots/<id>/export`, a tar.gz) and unpacks it in memory.
 * Returns path -> bytes for every entry.
 */
export async function exportBot(s: Session): Promise<Map<string, Buffer>> {
  const res = await fetch(`${s.base}/api/v1/admin/workspace/bots/${BOT_ID}/export`, { headers: { Authorization: `Bearer ${s.jwt}` } })
  if (!res.ok) throw new Error(`export ${s.base}: ${res.status}`)
  return untar(gunzipSync(Buffer.from(await res.arrayBuffer())))
}

/** Minimal ustar reader: regular files only, paths as stored (a leading "./" is dropped). */
export function untar(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  const str = (from: number, to: number) => buf.toString('utf8', from, to).replace(/\0[\s\S]*$/, '')
  let off = 0
  while (off + 512 <= buf.length) {
    const name = str(off, off + 100)
    const prefix = str(off + 345, off + 500)
    if (!name && !prefix) break
    const size = parseInt(str(off + 124, off + 136).trim() || '0', 8)
    const type = String.fromCharCode(buf[off + 156])
    const full = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, '')
    off += 512
    if (type === '0' || type === '\0') out.set(full, buf.subarray(off, off + size))
    off += Math.ceil(size / 512) * 512
  }
  return out
}

/** Element fields that are generated (ids) or stamped (dates, creator) and never structure. */
const GENERATED_ELEMENT_KEYS = new Set(['id', 'createdBy', 'createdOn', 'modifiedBy', 'modifiedOn'])

/** Content elements of one export file without ids and dates, sorted (ids are compared through the flows). */
export function contentStructure(elements: ContentElement[]): unknown[] {
  return elements
    .map((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !GENERATED_ELEMENT_KEYS.has(k))))
    .sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1))
}

/** Names and ids present in the bot before a scenario: the fixture every later node is compared against. */
export function fixtureOf(flows: Flow[]) {
  return {
    ids: new Set(flows.flatMap((f) => f.nodes.map((n) => n.id))),
    names: new Set(flows.flatMap((f) => f.nodes.map((n) => n.name))),
    flows: new Set(flows.map((f) => f.name)),
  }
}

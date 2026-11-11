/** Shapes of the legacy flow format, kept as-is so unknown fields survive a save. */

export interface Transition {
  condition: string
  node: string
  caption?: string
  [extra: string]: unknown
}

export interface FlowNodeJson {
  id: string
  name: string
  type?: 'standard' | 'skill-call' | string
  /** legacy writes null on skill-call nodes. */
  onEnter?: string[] | null
  onReceive?: string[] | null
  next: Transition[]
  skill?: string
  flow?: string
  [extra: string]: unknown
}

export interface CatchAll {
  onReceive: string[] | null
  next: Transition[]
}

export interface FlowJson {
  version?: string
  catchAll?: CatchAll
  startNode: string
  skillData?: unknown
  label?: string
  description?: string
  nodes: FlowNodeJson[]
  [extra: string]: unknown
}

export interface Point {
  x: number
  y: number
}

export interface UiLink {
  source: string
  target: string
  points: Point[]
  [extra: string]: unknown
}

/** `*.json`: node positions and link geometry, stored next to each flow. */
export interface UiJson {
  nodes: { id: string; position: Point }[]
  links: UiLink[]
}

/** What `GET /flows` returns: the flow plus its layout merged onto each node. */
export interface FlowView extends FlowJson {
  name: string
  location: string
  nodes: (FlowNodeJson & Point)[]
  links: UiLink[]
}

export interface Bot {
  id: string
  name: string
  category?: string
  defaultLanguage?: string
}

export interface ActionParamDef {
  name: string
  type: string
  description?: string
  default?: unknown
  required?: boolean
}

/** One entry of `GET /actions`. */
export interface ActionDef {
  name: string
  scope: 'global' | 'bot'
  legacy?: boolean
  title?: string
  category?: string
  description?: string
  hidden?: boolean
  params: ActionParamDef[]
}

export interface ContentElement {
  id: string
  contentType: string
  formData: Record<string, unknown>
  createdOn?: string
  modifiedOn?: string
}

/** Code-editor file (EditableFile). Hooks are located relative to hooks/{hookType}/. */
export interface CodeFile {
  name: string
  type: 'action_legacy' | 'hook'
  location: string
  botId?: string
  hookType?: string
  content?: string
}

/** Result of generateFlow: a complete flow file plus the transitions for the skill node. */
export interface SkillChoiceFlowResult {
  flow: FlowJson & { name?: string; location?: string }
  transitions: Transition[]
}

/** Converse API response (only the parts the editor reads). */
export type ResponsePayload =
  | { type: 'text'; text: string; markdown?: boolean }
  | { type: 'single-choice'; text?: string; choices: { title: string; value: string }[]; isDropdown?: boolean }
  | { type: 'carousel'; items: { title: string; subtitle?: string; image?: string }[] }
  | { type: 'image'; image: string; title?: string }
  | { type: 'file'; file: string; title?: string }
  | { type: string; [extra: string]: unknown }

export interface ConverseResponse {
  responses: ResponsePayload[]
  state?: {
    context?: { currentNode?: string; currentFlow?: string; previousNode?: string }
    session?: Record<string, unknown>
    temp?: Record<string, unknown>
    user?: Record<string, unknown>
    __stacktrace?: unknown
    [extra: string]: unknown
  }
}

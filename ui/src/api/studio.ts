import { request } from './http'
import type { ActionDef, ContentElement, FlowView, SkillChoiceFlowResult } from './types'

/** Studio endpoints under /api/v1/studio/{botId}, as documented in docs/studioapi.md. */
const base = (botId: string) => `/api/v1/studio/${encodeURIComponent(botId)}`

export function listFlows(botId: string): Promise<FlowView[]> {
  return request<FlowView[]>(`${base(botId)}/flows`)
}

/** Creates a flow. The server answers 400 when the name already exists. */
export function createFlow(botId: string, flow: FlowView): Promise<void> {
  return request(`${base(botId)}/flows`, { body: { flow } })
}

/** Updates a flow; a changed `flow.name` renames it on the server. The path name is used verbatim. */
export function saveFlow(botId: string, previousName: string, flow: FlowView): Promise<void> {
  return request(`${base(botId)}/flows/${previousName}`, { body: { flow } })
}

export function deleteFlow(botId: string, name: string): Promise<void> {
  return request(`${base(botId)}/flows/${name}/delete`, { body: {} })
}

export function listActions(botId: string): Promise<ActionDef[]> {
  return request<ActionDef[]>(`${base(botId)}/actions`)
}

export function listContentElements(botId: string): Promise<ContentElement[]> {
  return request<ContentElement[]>(`${base(botId)}/cms/elements`, { body: { count: 1000, from: 0 } })
}

/** Creates an element (no id) or updates one (with id). The response is the element id as plain text. */
export function saveContentElement(
  botId: string,
  contentType: string,
  elementId: string | null,
  formData: Record<string, unknown>,
): Promise<string> {
  const suffix = elementId ? `/element/${encodeURIComponent(elementId)}` : '/element'
  return request<string>(`${base(botId)}/cms/${encodeURIComponent(contentType)}${suffix}`, {
    body: { formData },
    responseType: 'text',
  })
}

/** Uploads an image or file for a content element. Returns the URL to store in formData. */
export async function uploadMedia(botId: string, file: File): Promise<string> {
  const form = new FormData()
  form.append('file', file)
  const res = await request<{ url: string }>(`${base(botId)}/media`, { form })
  return res.url
}

/**
 * Generates the choice skill flow from a question content element. The result is saved as a new
 * `skills/choice-<randomId>. on`, and `transitions` go on the skill node.
 */
export function generateChoiceFlow(
  botId: string,
  input: {
    contentId: string
    invalidContentId?: string
    /** One entry per choice: choice value -> candidate strings the user may type (legacy keywords). */
    keywords: Record<string, string[]>
    nbMaxRetries: number
    repeatChoicesOnInvalid?: boolean
    randomId: string
  },
): Promise<SkillChoiceFlowResult> {
  return request<SkillChoiceFlowResult>(`${base(botId)}/modules/basic-skills/skill/choice/generateFlow`, {
 // Legacy generator: its standard and skill-call nodes are what the engine runs. The one-flow
 // variant emits trigger/success nodes the engine does not support (rejected by flow.Validate).
    query: { isOneFlow: false },
 // Key order follows legacy's skill data (randomId first): the generator copies the body into the
 // parse action's args, and that string is compared with legacy's.
    body: {
      randomId: input.randomId,
      contentId: input.contentId,
      invalidContentId: input.invalidContentId ?? '',
      keywords: input.keywords,
      config: { nbMaxRetries: input.nbMaxRetries, repeatChoicesOnInvalid: input.repeatChoicesOnInvalid ?? false, variableName: '' },
    },
  })
}

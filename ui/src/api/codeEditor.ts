import { request } from './http'
import type { CodeFile } from './types'

/** Code-editor module API, mounted per bot (legacy code-editor module, see docs/studioapi.md). */
const base = (botId: string) => `/api/v1/bots/${encodeURIComponent(botId)}/mod/code-editor`

export interface CodeFiles {
  'bot.actions': CodeFile[]
  'bot.hooks': CodeFile[]
}

export function listCodeFiles(botId: string): Promise<CodeFiles> {
  return request<CodeFiles>(`${base(botId)}/files`)
}

/** Bodies are the EditableFile itself, with `botId` set for bot-scoped files. */
function editable(botId: string, file: CodeFile): CodeFile {
  return { name: file.name, type: file.type, location: file.location, hookType: file.hookType, botId }
}

export async function readCodeFile(botId: string, file: CodeFile): Promise<string> {
  const res = await request<{ fileContent: string }>(`${base(botId)}/readFile`, { body: editable(botId, file) })
  return res.fileContent
}

export function saveCodeFile(botId: string, file: CodeFile, content: string): Promise<void> {
  return request(`${base(botId)}/save`, { body: { ...editable(botId, file), content } })
}

export function deleteCodeFile(botId: string, file: CodeFile): Promise<void> {
  return request(`${base(botId)}/remove`, { body: editable(botId, file) })
}

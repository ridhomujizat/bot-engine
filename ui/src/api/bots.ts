import { request, requestBlob } from './http'
import type { Bot } from './types'

/** Admin bot list. Bot create is not built in the backend, so there is no create call. */
const WORKSPACE = '/api/v1/admin/workspace/bots'

interface BotsResponse {
  status: string
  message: string
  payload: { bots: Bot[] }
}

export async function listBots(): Promise<Bot[]> {
  const res = await request<BotsResponse>(WORKSPACE)
  return res.payload.bots
}

/** Downloads the bot as a.tgz archive in the legacy export format. */
export function exportBot(botId: string) {
  return requestBlob(`${WORKSPACE}/${encodeURIComponent(botId)}/export`)
}

/** Imports a.tgz archive. Overwrites an existing bot only when asked to. */
export async function importBot(botId: string, archive: Blob, overwrite: boolean): Promise<void> {
  await request(`${WORKSPACE}/${encodeURIComponent(botId)}/import`, {
    method: 'POST',
    raw: archive,
    contentType: 'application/tar+gzip',
    query: { overwrite },
  })
}

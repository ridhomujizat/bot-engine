import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/basic-languages/monaco.contribution'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'

let configured = false

/**
 * Uses the bundled Monaco instead of the CDN, so the editor works offline and inside the Go binary.
 * Only the editor core and JavaScript are included: action code is plain JS and needs no TS service.
 */
export function configureMonaco(): void {
  if (configured) return
  configured = true
  self.MonacoEnvironment = { getWorker: () => new editorWorker() }
  loader.config({ monaco })
}

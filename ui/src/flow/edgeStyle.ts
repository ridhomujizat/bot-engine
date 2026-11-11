/**
 * Edge drawing style. "orthogonal" routes transitions with rounded right-angle segments;
 * "straight" draws one line from source port to target port, like legacy.
 * The choice is a per-browser view preference: it never changes a saved file.
 */
export type EdgeStyle = 'straight' | 'orthogonal'

export const EDGE_STYLE_KEY = 'bot-engine.edgeStyle'
export const DEFAULT_EDGE_STYLE: EdgeStyle = 'orthogonal'

export function parseEdgeStyle(value: unknown): EdgeStyle {
  return value === 'straight' ? 'straight' : DEFAULT_EDGE_STYLE
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** Reads the saved style. Unavailable or unreadable storage gives the default. */
export function readEdgeStyle(storage: Storage | null = browserStorage()): EdgeStyle {
  try {
    return parseEdgeStyle(storage?.getItem(EDGE_STYLE_KEY))
  } catch {
    return DEFAULT_EDGE_STYLE
  }
}

/** Saves the style. Storage that refuses the write just means the choice is not remembered. */
export function writeEdgeStyle(style: EdgeStyle, storage: Storage | null = browserStorage()): void {
  try {
    storage?.setItem(EDGE_STYLE_KEY, style)
  } catch {
    /* not remembered */
  }
}

/**
 * Per-browser view settings of the emulator (open drawer, its height, quick start). Storage can be
 * blocked or full: every access is guarded and a failure just means the default applies.
 */
const PREFIX = 'bot-engine.emulator.'

export const PREF_DRAWER_OPEN = 'drawerOpen'
export const PREF_DRAWER_HEIGHT = 'drawerHeight'
export const PREF_QUICK_START = 'quickStart'
/** Editor follows the emulator's conversation (flow and node) after each reply. On unless turned off. */
export const PREF_FOLLOW = 'followConversation'

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readPref(key: string): string | null {
  try {
    return storage()?.getItem(PREFIX + key) ?? null
  } catch {
    return null
  }
}

export function writePref(key: string, value: string): void {
  try {
    storage()?.setItem(PREFIX + key, value)
  } catch {
    /* not remembered */
  }
}

export function readFlag(key: string, fallback: boolean): boolean {
  const value = readPref(key)
  return value === null ? fallback : value === '1'
}

export function writeFlag(key: string, value: boolean): void {
  writePref(key, value ? '1' : '0')
}

export function readNumber(key: string, fallback: number): number {
  const value = Number(readPref(key))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

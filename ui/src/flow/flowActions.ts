import { createContext, useContext } from 'react'
import type { FlowTarget } from './navigation'

/** The tabs of the node properties panel. */
export type InspectorTab = 'onEnter' | 'onReceive' | 'transitions'

/**
 * What a click on a row of a node card opens. `action` and `transition` also open that row's edit
 * dialog; `tab` only switches the panel (the empty-state rows).
 */
export type NodeTarget =
  | { kind: 'action'; section: 'onEnter' | 'onReceive'; index: number }
  | { kind: 'transition'; index: number }
  | { kind: 'tab'; tab: InspectorTab }

/** Callbacks the node and edge components use without prop drilling through React Flow. */
export interface FlowActions {
  /** A terminal pill that names a flow (`flow.json` or `flow.json#node`) was opened. */
  openFlow: (target: FlowTarget) => void
  removeTransition: (nodeId: string, index: number) => void
  editTransition: (nodeId: string, index: number) => void
  /** A row of a node card was clicked (never after a drag): selects the node and opens the target. */
  openNodeTarget: (nodeId: string, target: NodeTarget) => void
}

export const FlowActionsContext = createContext<FlowActions>({
  openFlow: () => {},
  removeTransition: () => {},
  editTransition: () => {},
  openNodeTarget: () => {},
})

export function useFlowActions(): FlowActions {
  return useContext(FlowActionsContext)
}

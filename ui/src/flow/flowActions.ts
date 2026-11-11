import { createContext, useContext } from 'react'

/** Callbacks the edge and node components use without prop drilling through React Flow. */
export interface FlowActions {
  removeTransition: (nodeId: string, index: number) => void
  editTransition: (nodeId: string, index: number) => void
}

export const FlowActionsContext = createContext<FlowActions>({
  removeTransition: () => {},
  editTransition: () => {},
})

export function useFlowActions(): FlowActions {
  return useContext(FlowActionsContext)
}

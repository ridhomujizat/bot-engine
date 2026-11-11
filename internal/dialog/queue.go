package dialog

import "github.com/ridhomujizat/bot-engine/internal/model"

// queueBuilder ports dialog/ and dialog/instruction/
type queueBuilder struct {
	node            *model.FlowNode
	flow            *model.Flow
	onlyTransitions bool
	hasJumped       bool
}

func newQueueBuilder(node *model.FlowNode, flow *model.Flow) *queueBuilder {
	return &queueBuilder{node: node, flow: flow}
}

// hasJumpedMode mirrors InstructionsQueueBuilder.hasJumped.
func (b *queueBuilder) withJumped() *queueBuilder { b.hasJumped = true; return b }

// onlyTransitionsMode mirrors InstructionsQueueBuilder.onlyTransitions.
func (b *queueBuilder) withOnlyTransitions() *queueBuilder { b.onlyTransitions = true; return b }

// build mirrors InstructionsQueueBuilder.build.
func (b *queueBuilder) build() *queue {
	q := &queue{}

	// After jumpTo, the flow's catchAll transitions run before anything else.
	// legacy The final transitions below include catchAll
	// transitions again, so they can appear twice; this is legacy behaviour.
	if b.hasJumped {
		q.enqueue(transitionInstructions(b.flow, nil)...)
		b.hasJumped = false
	}

	if !b.onlyTransitions {
		for _, fn := range b.node.OnEnter {
			q.enqueue(instruction{Type: "on-enter", Fn: fn})
		}
		// createOnReceive: undefined (no wait) when node.onReceive is null.
		if b.node.OnReceive != nil {
			q.enqueue(instruction{Type: "wait"})
			for _, fn := range flowReceive(b.flow) {
				q.enqueue(instruction{Type: "on-receive", Fn: fn})
			}
			for _, fn := range *b.node.OnReceive {
				q.enqueue(instruction{Type: "on-receive", Fn: fn})
			}
		}
	}

	q.enqueue(transitionInstructions(b.flow, b.node)...)
	return q
}

// flowReceive is catchAll.onReceive, used only for nodes that wait for input.
func flowReceive(f *model.Flow) []string {
	if f.CatchAll == nil || f.CatchAll.OnReceive == nil {
		return nil
	}
	return *f.CatchAll.OnReceive
}

// transitionInstructions mirrors InstructionFactory.createTransition. Catch-all
// transitions that point to the current node are skipped to avoid loops.
func transitionInstructions(flow *model.Flow, node *model.FlowNode) []instruction {
	var out []instruction
	if flow != nil && flow.CatchAll != nil {
		for _, t := range flow.CatchAll.Next {
			if t == nil {
				continue
			}
			if node != nil && node.Name != "" && t.Node == node.Name {
				continue
			}
			out = append(out, instruction{Type: "transition", Fn: t.Condition, Node: t.Node})
		}
	}
	if node != nil {
		for _, t := range node.Next {
			if t == nil {
				continue
			}
			out = append(out, instruction{Type: "transition", Fn: t.Condition, Node: t.Node})
		}
	}
	return out
}

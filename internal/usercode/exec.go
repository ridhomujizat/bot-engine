package usercode

import (
	"context"
	"errors"
	"fmt"

	"github.com/dop251/goja"
)

// execution is one run of bot code: a fresh goja runtime plus the event loop
// that drives Promises from Go. All JS-facing state is touched only from the
// goroutine that calls run; background Go work reports back through jobs.
type execution struct {
	r       *runner
	ctx     context.Context
	vm      *goja.Runtime
	botID   string
	host    Host
	full    bool // false for transition conditions: no bp, require, Buffer
	bp      goja.Value
	process goja.Value

	// jobs carries completions of background work to the loop goroutine.
	jobs chan func()
	// done is closed when the execution ends so background work can exit.
	done chan struct{}
	// pending counts background operations whose completion has not run yet.
	pending int

	prelude *goja.Object
	modules map[string]goja.Value
}

func (r *runner) newExecution(ctx context.Context, botID string, host Host, full bool) (*execution, error) {
	e := &execution{
		r:       r,
		ctx:     ctx,
		vm:      goja.New(),
		botID:   botID,
		host:    host,
		full:    full,
		jobs:    make(chan func()),
		done:    make(chan struct{}),
		modules: map[string]goja.Value{},
	}
	e.installConsole()
	if full {
		if err := e.installFull(); err != nil {
			return nil, err
		}
	}
	return e, nil
}

func (e *execution) close() {
	close(e.done)
}

// installFull adds the globals that action and hook code expects. Conditions
// only get console.
func (e *execution) installFull() error {
	e.bp = e.newBP()
	process := e.vm.NewObject()
	_ = process.Set("env", e.vm.NewObject())
	e.process = process
	_ = e.vm.Set("process", process)
	_ = e.vm.Set("require", e.requireFunc(""))

	prelude, err := e.loadPrelude()
	if err != nil {
		return err
	}
	_ = e.vm.Set("Buffer", getProp(prelude, "Buffer"))
	_ = e.vm.Set("URLSearchParams", getProp(prelude, "URLSearchParams"))
	return nil
}

// bindSandbox builds the JS view of sb. It is a deep copy; writeBack copies
// the JS state back into sb. Objects that legacy would default to {} (user,
// session, temp, bot, workflow) are attached to event.state when present, so
// mutations land in the state, and are detached copies otherwise (as in legacy).
type sandboxJS struct {
	event    *goja.Object
	user     goja.Value
	session  goja.Value
	temp     goja.Value
	bot      goja.Value
	workflow goja.Value
}

func (e *execution) bindSandbox(sb *Sandbox) (*sandboxJS, error) {
	if sb == nil {
		sb = &Sandbox{}
	}
	if sb.Event == nil {
		sb.Event = map[string]any{}
	}
	ev, ok := toJS(e.vm, sb.Event).(*goja.Object)
	if !ok {
		return nil, errors.New("usercode: sandbox event must be an object")
	}
	state, _ := getProp(ev, "state").(*goja.Object)
	field := func(name string) goja.Value {
		if state != nil {
			if v := getProp(state, name); !goja.IsUndefined(v) && !goja.IsNull(v) {
				return v
			}
		}
		return e.vm.NewObject()
	}
	return &sandboxJS{
		event:    ev,
		user:     field("user"),
		session:  field("session"),
		temp:     field("temp"),
		bot:      field("bot"),
		workflow: field("workflow"),
	}, nil
}

// writeBack copies the (possibly mutated) JS event back into sb.Event.
func (e *execution) writeBack(sb *Sandbox, sbj *sandboxJS) error {
	out, ok, err := toGo(sbj.event)
	if err != nil {
		return err
	}
	m, isMap := out.(map[string]any)
	if !ok || !isMap {
		return errors.New("usercode: event is no longer an object")
	}
	if sb == nil {
		return nil
	}
	sb.Event = m
	return nil
}

// runWrapped compiles src (a function expression), calls it with the args
// produced by argsFn, and drives the returned Promise to completion.
// The sandbox is written back in every outcome, like legacy where state written
// before a throw persists.
func (e *execution) runWrapped(name, src string, sb *Sandbox, argsFn func(*sandboxJS) []goja.Value) (result goja.Value, err error) {
	sbj, err := e.bindSandbox(sb)
	if err != nil {
		return nil, err
	}
	defer func() {
		if wbErr := e.writeBack(sb, sbj); wbErr != nil && err == nil {
			err = fmt.Errorf("%s: %w", name, wbErr)
		}
	}()

	stop := make(chan struct{})
	defer close(stop)
	go func() {
		select {
		case <-e.ctx.Done():
			e.vm.Interrupt(errInterrupted)
		case <-stop:
		}
	}()

	defer func() {
		if rec := recover(); rec != nil {
			err = e.wrapPanic(name, rec)
			result = nil
		}
	}()

	prog, err := e.r.programs.compile(name, src)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	fv, err := e.vm.RunProgram(prog)
	if err != nil {
		return nil, e.wrapErr(name, err)
	}
	fn, ok := goja.AssertFunction(fv)
	if !ok {
		return nil, fmt.Errorf("%s: wrapper is not a function", name)
	}
	ret, err := fn(goja.Undefined(), argsFn(sbj)...)
	if err != nil {
		return nil, e.wrapErr(name, err)
	}
	promise, isPromise := ret.Export().(*goja.Promise)
	if !isPromise {
		return ret, nil
	}
	value, err := e.settle(promise)
	if err != nil {
		return nil, e.wrapErr(name, err)
	}
	return value, nil
}

// settle runs the event loop until promise settles and every background
// operation it started has completed. Background work is bounded by ctx.
func (e *execution) settle(p *goja.Promise) (goja.Value, error) {
	for p.State() == goja.PromiseStatePending {
		if e.pending == 0 {
			return nil, errors.New("promise never settled: nothing left to wait for")
		}
		if err := e.runOneJob(); err != nil {
			return nil, err
		}
	}
	for e.pending > 0 {
		if err := e.runOneJob(); err != nil {
			return nil, err
		}
	}
	if p.State() == goja.PromiseStateRejected {
		return nil, jsErrorFrom(p.Result())
	}
	return p.Result(), nil
}

func (e *execution) runOneJob() error {
	select {
	case job := <-e.jobs:
		job()
		return nil
	case <-e.ctx.Done():
		return e.ctx.Err()
	}
}

// spawn runs work on its own goroutine (it must not touch the VM) and then
// calls done on the loop goroutine with its result.
func (e *execution) spawn(work func() (any, error), done func(any, error)) {
	e.pending++
	go func() {
		res, err := work()
		select {
		case e.jobs <- func() {
			e.pending--
			done(res, err)
		}:
		case <-e.done:
		}
	}()
}

// wrapErr turns goja errors into Go errors that keep the JS message and stack.
func (e *execution) wrapErr(name string, err error) error {
	var interrupted *goja.InterruptedError
	if errors.As(err, &interrupted) {
		if cerr := e.ctx.Err(); cerr != nil {
			return fmt.Errorf("%s: %w", name, cerr)
		}
		return fmt.Errorf("%s: %w", name, errInterrupted)
	}
	var ex *goja.Exception
	if errors.As(err, &ex) {
		return fmt.Errorf("%s: %w", name, jsErrorFrom(ex.Value()))
	}
	return fmt.Errorf("%s: %w", name, err)
}

func (e *execution) wrapPanic(name string, rec any) error {
	if ex, ok := rec.(*goja.Exception); ok {
		return fmt.Errorf("%s: %w", name, jsErrorFrom(ex.Value()))
	}
	if ie, ok := rec.(*goja.InterruptedError); ok {
		return e.wrapErr(name, ie)
	}
	return fmt.Errorf("%s: internal error: %v", name, rec)
}

// jsErrorFrom converts a thrown JS value into a *JSError.
func jsErrorFrom(v goja.Value) error {
	if v == nil || goja.IsUndefined(v) || goja.IsNull(v) {
		return &JSError{Message: "undefined exception"}
	}
	obj, ok := v.(*goja.Object)
	if !ok {
		return &JSError{Message: v.String()}
	}
	jsErr := &JSError{}
	if n := getProp(obj, "name"); !goja.IsUndefined(n) {
		jsErr.Name = n.String()
	}
	if m := getProp(obj, "message"); !goja.IsUndefined(m) {
		jsErr.Message = m.String()
	} else {
		jsErr.Message = obj.String()
	}
	if s := getProp(obj, "stack"); !goja.IsUndefined(s) {
		jsErr.Stack = s.String()
	}
	return jsErr
}

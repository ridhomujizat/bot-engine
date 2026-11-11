package usercode

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/dop251/goja"
)

// Options configures a Runner created by New.
type Options struct {
	// Console receives console.log/info/warn/error/debug output from bot code
	// and the TypeError log of transition conditions. Nil means os.Stderr.
	Console io.Writer
	// Timeout bounds every RunAction, RunHook and EvalCondition call on top of
	// the caller's ctx. Zero means 30 seconds.
	Timeout time.Duration
	// HTTPClient performs axios requests. Nil means a client with no transport
	// timeout; request deadlines come from the ctx and the axios timeout option.
	HTTPClient *http.Client
}

const defaultTimeout = 30 * time.Second

// New returns a Runner that is safe for concurrent use. Each call gets its own
// goja runtime; compiled programs are cached and shared.
func New(opts Options) Runner {
	if opts.Console == nil {
		opts.Console = os.Stderr
	}
	if opts.Timeout <= 0 {
		opts.Timeout = defaultTimeout
	}
	if opts.HTTPClient == nil {
		opts.HTTPClient = &http.Client{}
	}
	return &runner{opts: opts, programs: newProgramCache()}
}

type runner struct {
	opts     Options
	programs *programCache
}

// Compile-time check that runner satisfies the shared contract.
var _ Runner = (*runner)(nil)

func (r *runner) RunAction(ctx context.Context, name, code string, sb *Sandbox, host Host) (any, error) {
	ctx, cancel := r.withTimeout(ctx)
	defer cancel()

	botID := ""
	if sb != nil {
		botID = sb.BotID
	}
	e, err := r.newExecution(ctx, botID, host, true)
	if err != nil {
		return nil, err
	}
	defer e.close()

	src := "(async function (bp, event, user, temp, session, args, process) {" + code + "\n})"
	fnName := "actions/" + name + ".js"
	result, err := e.runWrapped(fnName, src, sb, func(sbj *sandboxJS) []goja.Value {
		return []goja.Value{
			e.bp,
			sbj.event,
			sbj.user,
			sbj.temp,
			sbj.session,
			toJS(e.vm, argsOrEmpty(sb)),
			e.process,
		}
	})
	if err != nil {
		return nil, err
	}
	out, _, err := toGo(result)
	return out, err
}

func (r *runner) RunHook(ctx context.Context, hookType, name, code string, sb *Sandbox, host Host) error {
	ctx, cancel := r.withTimeout(ctx)
	defer cancel()

	botID := ""
	if sb != nil {
		botID = sb.BotID
	}
	e, err := r.newExecution(ctx, botID, host, true)
	if err != nil {
		return err
	}
	defer e.close()

	src := "(async function (bp, event, process) {" + code + "\n})"
	fnName := fmt.Sprintf("hooks/%s/%s.js", hookType, name)
	_, err = e.runWrapped(fnName, src, sb, func(sbj *sandboxJS) []goja.Value {
		return []goja.Value{e.bp, sbj.event, e.process}
	})
	return err
}

// EvalCondition follows legacy TransitionStrategy.runCode: "true" always passes,
// "lastNode=X" compares against the previous entry of event.state.__stacktrace,
// anything else is evaluated as `return <expr>` inside try/catch where a
// TypeError yields false and every other error propagates.
func (r *runner) EvalCondition(ctx context.Context, expr string, sb *Sandbox) (bool, error) {
	if expr == "true" {
		return true, nil
	}
	if strings.HasPrefix(expr, "lastNode") {
		return lastNodeMatches(expr, sb), nil
	}

	ctx, cancel := r.withTimeout(ctx)
	defer cancel()

	e, err := r.newExecution(ctx, "", nil, false)
	if err != nil {
		return false, err
	}
	defer e.close()

	src := "(function (event, user, temp, session, bot, workflow) {\n" +
		"try {\n" +
		"return " + expr + ";\n" +
		"} catch (err) {\n" +
		"if (err instanceof TypeError) {\n" +
		"console.log(err);\n" +
		"return false;\n" +
		"}\n" +
		"throw err;\n" +
		"}\n})"
	result, err := e.runWrapped("condition", src, sb, func(sbj *sandboxJS) []goja.Value {
		return []goja.Value{sbj.event, sbj.user, sbj.temp, sbj.session, sbj.bot, sbj.workflow}
	})
	if err != nil {
		return false, err
	}
	return result.ToBoolean(), nil
}

func (r *runner) withTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithTimeout(ctx, r.opts.Timeout)
}

// lastNodeMatches mirrors the `lastNode` branch of TransitionStrategy.runCode.
func lastNodeMatches(expr string, sb *Sandbox) bool {
	var stack []any
	if sb != nil && sb.Event != nil {
		if state, ok := sb.Event["state"].(map[string]any); ok {
			stack, _ = state["__stacktrace"].([]any)
		}
	}
	if len(stack) == 0 {
		return false
	}
	last := stack[0]
	if len(stack) > 1 {
		last = stack[len(stack)-2] // the previous node, not the current one
	}
	entry, _ := last.(map[string]any)
	node, present := entry["node"]
	return expr == "lastNode="+jsString(node, present && node != nil)
}

func argsOrEmpty(sb *Sandbox) map[string]any {
	if sb == nil || sb.Args == nil {
		return map[string]any{}
	}
	return sb.Args
}

// JSError is an exception thrown by bot code, or a rejection reason.
type JSError struct {
	Name    string
	Message string
	Stack   string
}

func (e *JSError) Error() string {
	if e.Name == "" {
		return e.Message
	}
	if e.Message == "" {
		return e.Name
	}
	return e.Name + ": " + e.Message
}

// errInterrupted is the value passed to vm.Interrupt when the ctx ends.
var errInterrupted = errors.New("usercode: interrupted")

package usercode

import (
	"embed"
	"errors"
	"fmt"
	"path"
	"strings"

	"github.com/dop251/goja"
)

// jsFiles holds the vendored npm packages and the JS prelude.
//
//go:embed js
var jsFiles embed.FS

// bareModules maps require names to embedded CommonJS entry files.
// Versions are recorded in each directory's on.
var bareModules = map[string]string{
	"qs":           "js/qs/lib/index.js",
	"moment":       "js/moment/moment.js",
	"lodash":       "js/lodash/lodash.js",
	"side-channel": "js/side-channel/index.js",
}

// moduleNotFound mirrors Node's MODULE_NOT_FOUND error.
type moduleNotFound struct{ name string }

func (m *moduleNotFound) Error() string {
	return fmt.Sprintf("Cannot find module '%s'", m.name)
}

// loadPrelude evaluates js/ once per execution and returns its exports.
func (e *execution) loadPrelude() (*goja.Object, error) {
	if e.prelude != nil {
		return e.prelude, nil
	}
	src, err := jsFiles.ReadFile("js/prelude.js")
	if err != nil {
		return nil, err
	}
	prog, err := e.r.programs.compile("js/prelude.js", string(src))
	if err != nil {
		return nil, fmt.Errorf("prelude: %w", err)
	}
	fv, err := e.vm.RunProgram(prog)
	if err != nil {
		return nil, fmt.Errorf("prelude: %w", e.wrapErr("prelude", err))
	}
	fn, ok := goja.AssertFunction(fv)
	if !ok {
		return nil, errors.New("prelude: not a function")
	}
	ret, err := fn(goja.Undefined(), e.natives())
	if err != nil {
		return nil, fmt.Errorf("prelude: %w", e.wrapErr("prelude", err))
	}
	exports, ok := ret.(*goja.Object)
	if !ok {
		return nil, errors.New("prelude: no exports")
	}
	e.prelude = exports
	return exports, nil
}

// requireFunc returns a CommonJS require bound to dir (the directory of the
// requiring module; empty for bot code, which has no relative requires).
func (e *execution) requireFunc(dir string) goja.Value {
	return e.fn(func(call goja.FunctionCall) goja.Value {
		v, err := e.require(dir, call.Argument(0).String())
		if err != nil {
			panic(e.jsError(err))
		}
		return v
	})
}

func (e *execution) require(dir, name string) (goja.Value, error) {
	name = strings.TrimPrefix(name, "node:")

	if isPreludeModule(name) {
		prelude, err := e.loadPrelude()
		if err != nil {
			return nil, err
		}
		mods, _ := getProp(prelude, "modules").(*goja.Object)
		return getProp(mods, name), nil
	}
	if entry, ok := bareModules[name]; ok {
		return e.loadLib(entry)
	}
	if dir != "" && (strings.HasPrefix(name, "./") || strings.HasPrefix(name, "../")) {
		base := path.Clean(path.Join(dir, name))
		for _, candidate := range []string{base, base + ".js", base + "/index.js"} {
			if _, err := jsFiles.Open(candidate); err == nil {
				return e.loadLib(candidate)
			}
		}
	}
	return nil, &moduleNotFound{name: name}
}

func isPreludeModule(name string) bool {
	switch name {
	case "axios", "form-data", "crypto", "buffer", "url":
		return true
	}
	return false
}

// loadLib runs an embedded CommonJS file once per execution and caches its
// module.exports.
func (e *execution) loadLib(entry string) (goja.Value, error) {
	if v, ok := e.modules[entry]; ok {
		return v, nil
	}
	src, err := jsFiles.ReadFile(entry)
	if err != nil {
		return nil, &moduleNotFound{name: entry}
	}
	wrapper := "(function (exports, require, module, __filename, __dirname) {" + string(src) + "\n})"
	prog, err := e.r.programs.compile(entry, wrapper)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", entry, err)
	}
	fv, err := e.vm.RunProgram(prog)
	if err != nil {
		return nil, e.wrapErr(entry, err)
	}
	fn, ok := goja.AssertFunction(fv)
	if !ok {
		return nil, fmt.Errorf("%s: not a module wrapper", entry)
	}

	dir := path.Dir(entry)
	module := e.vm.NewObject()
	exports := e.vm.NewObject()
	_ = module.Set("exports", exports)
	// Register before running so a require cycle sees the partial exports.
	e.modules[entry] = exports
	_, err = fn(exports, exports, e.requireFunc(dir), module, e.vm.ToValue(entry), e.vm.ToValue(dir))
	if err != nil {
		delete(e.modules, entry)
		return nil, e.wrapErr(entry, err)
	}
	result := getProp(module, "exports")
	e.modules[entry] = result
	return result, nil
}

// jsError converts a Go error into a JS Error; a missing module gets the
// Node error code.
func (e *execution) jsError(err error) goja.Value {
	obj := e.vm.NewGoError(err)
	var missing *moduleNotFound
	if errors.As(err, &missing) {
		_ = obj.Set("code", "MODULE_NOT_FOUND")
	}
	return obj
}

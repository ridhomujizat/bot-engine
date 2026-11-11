package usercode

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"

	"github.com/dop251/goja"
)

// maxCachedPrograms bounds the compiled-program cache. Bots are small, so the
// cache is cleared wholesale when it fills up rather than tracking LRU order.
const maxCachedPrograms = 4096

// programCache keeps compiled goja programs keyed by name and source hash.
// A goja.Program is immutable and may be run in any runtime, so one entry
// serves every concurrent execution.
type programCache struct {
	mu sync.RWMutex
	m  map[string]*goja.Program
}

func newProgramCache() *programCache {
	return &programCache{m: map[string]*goja.Program{}}
}

func (c *programCache) compile(name, src string) (*goja.Program, error) {
	sum := sha256.Sum256([]byte(src))
	key := name + "\x00" + hex.EncodeToString(sum[:])

	c.mu.RLock()
	prog, ok := c.m[key]
	c.mu.RUnlock()
	if ok {
		return prog, nil
	}

	prog, err := goja.Compile(name, src, false)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	if len(c.m) >= maxCachedPrograms {
		c.m = map[string]*goja.Program{}
	}
	c.m[key] = prog
	c.mu.Unlock()
	return prog, nil
}

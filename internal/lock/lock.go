// Package lock provides distributed mutual exclusion so bot-engine can run
// with more than one replica: per-session lock for converse, singleton lock
// for the janitor.
//
// OWNERSHIP: interface + Memory impl = shared contract. Redis impl owned by the platform agent.
package lock

import (
	"context"
	"sync"
	"time"
)

type Locker interface {
	// Acquire blocks until the lock is held, ctx is done, or wait elapses.
	// ttl bounds how long the lock survives a crashed holder.
	// The returned release func is safe to call more than once.
	Acquire(ctx context.Context, key string, ttl, wait time.Duration) (release func(), err error)
	// TryAcquire returns ok=false immediately if the lock is held elsewhere.
	TryAcquire(ctx context.Context, key string, ttl time.Duration) (release func(), ok bool, err error)
}

// Memory is a single-process Locker for tests and single-replica dev.
type Memory struct {
	mu   sync.Mutex
	held map[string]chan struct{}
}

func NewMemory() *Memory { return &Memory{held: map[string]chan struct{}{}} }

func (m *Memory) TryAcquire(_ context.Context, key string, _ time.Duration) (func(), bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.held[key]; ok {
		return nil, false, nil
	}
	ch := make(chan struct{})
	m.held[key] = ch
	var once sync.Once
	return func() {
		once.Do(func() {
			m.mu.Lock()
			delete(m.held, key)
			m.mu.Unlock()
			close(ch)
		})
	}, true, nil
}

func (m *Memory) Acquire(ctx context.Context, key string, ttl, wait time.Duration) (func(), error) {
	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	for {
		rel, ok, _ := m.TryAcquire(ctx, key, ttl)
		if ok {
			return rel, nil
		}
		m.mu.Lock()
		ch := m.held[key]
		m.mu.Unlock()
		if ch == nil {
			continue
		}
		select {
		case <-ch:
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-deadline.C:
			return nil, ErrTimeout
		}
	}
}

type timeoutErr struct{}

func (timeoutErr) Error() string { return "lock: acquire timeout" }

var ErrTimeout error = timeoutErr{}

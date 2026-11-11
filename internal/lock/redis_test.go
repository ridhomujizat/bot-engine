package lock

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func newTestRedis(t *testing.T) (*Redis, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	return NewRedis(client), mr
}

func TestRedisTryAcquireExclusive(t *testing.T) {
	l, _ := newTestRedis(t)
	ctx := context.Background()

	rel, ok, err := l.TryAcquire(ctx, "session-1", time.Minute)
	if err != nil || !ok {
		t.Fatalf("first acquire: ok=%v err=%v", ok, err)
	}
	if _, ok, _ := l.TryAcquire(ctx, "session-1", time.Minute); ok {
		t.Fatal("second acquire on held key succeeded")
	}
	rel()
	rel() // idempotent
	if _, ok, _ := l.TryAcquire(ctx, "session-1", time.Minute); !ok {
		t.Fatal("acquire after release failed")
	}
}

func TestRedisReleaseDoesNotDeleteForeignToken(t *testing.T) {
	l, mr := newTestRedis(t)
	ctx := context.Background()

	rel, _, _ := l.TryAcquire(ctx, "k", time.Minute)
	// Simulate TTL expiry and another holder taking the key.
	mr.FastForward(2 * time.Minute)
	rel2, ok, _ := l.TryAcquire(ctx, "k", time.Minute)
	if !ok {
		t.Fatal("expired lock not re-acquirable")
	}
	rel() // stale release must not drop the new holder's lock
	if _, ok, _ := l.TryAcquire(ctx, "k", time.Minute); ok {
		t.Fatal("stale release freed a lock held by another owner")
	}
	rel2()
}

func TestRedisAcquireWaitsThenTimesOut(t *testing.T) {
	l, _ := newTestRedis(t)
	ctx := context.Background()

	rel, _, _ := l.TryAcquire(ctx, "busy", time.Minute)
	defer rel()

	start := time.Now()
	_, err := l.Acquire(ctx, "busy", time.Minute, 60*time.Millisecond)
	if err != ErrTimeout {
		t.Fatalf("want ErrTimeout, got %v", err)
	}
	if time.Since(start) < 50*time.Millisecond {
		t.Fatal("Acquire returned before wait elapsed")
	}
}

func TestRedisAcquireSucceedsWhenReleased(t *testing.T) {
	l, _ := newTestRedis(t)
	ctx := context.Background()

	rel, _, _ := l.TryAcquire(ctx, "x", time.Minute)
	go func() {
		time.Sleep(30 * time.Millisecond)
		rel()
	}()
	got, err := l.Acquire(ctx, "x", time.Minute, 2*time.Second)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	got()
}

func TestRedisAcquireHonorsContext(t *testing.T) {
	l, _ := newTestRedis(t)
	rel, _, _ := l.TryAcquire(context.Background(), "c", time.Minute)
	defer rel()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := l.Acquire(ctx, "c", time.Minute, time.Second); err != context.DeadlineExceeded {
		t.Fatalf("want context deadline, got %v", err)
	}
}

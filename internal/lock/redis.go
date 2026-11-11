package lock

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const keyPrefix = "bot-engine:lock:"

// releaseScript deletes the key only when it still holds our token, so a
// holder whose TTL expired cannot release a lock now owned by someone else.
var releaseScript = redis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`)

// Redis is a Locker backed by one Redis key per lock (SET NX PX).
type Redis struct {
	client redis.UniversalClient
	// minBackoff and maxBackoff bound the polling interval used by Acquire.
	minBackoff time.Duration
	maxBackoff time.Duration
}

// NewRedis wraps a go-redis client. Acquire polls with backoff between 10ms and 250ms.
func NewRedis(client redis.UniversalClient) *Redis {
	return &Redis{client: client, minBackoff: 10 * time.Millisecond, maxBackoff: 250 * time.Millisecond}
}

// TryAcquire takes the lock once. ok=false means it is held elsewhere.
func (r *Redis) TryAcquire(ctx context.Context, key string, ttl time.Duration) (func(), bool, error) {
	if ttl <= 0 {
		return nil, false, errors.New("lock: ttl must be positive")
	}
	token, err := newToken()
	if err != nil {
		return nil, false, err
	}
	fullKey := keyPrefix + key
	ok, err := r.client.SetNX(ctx, fullKey, token, ttl).Result()
	if err != nil {
		return nil, false, err
	}
	if !ok {
		return nil, false, nil
	}
	var once sync.Once
	release := func() {
		once.Do(func() {
			// Release uses a fresh context: the caller's ctx may already be done.
			rctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_ = releaseScript.Run(rctx, r.client, []string{fullKey}, token).Err()
		})
	}
	return release, true, nil
}

// Acquire polls TryAcquire until the lock is held, ctx is done, or wait elapses.
func (r *Redis) Acquire(ctx context.Context, key string, ttl, wait time.Duration) (func(), error) {
	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	backoff := r.minBackoff
	for {
		release, ok, err := r.TryAcquire(ctx, key, ttl)
		if err != nil {
			return nil, err
		}
		if ok {
			return release, nil
		}
		timer := time.NewTimer(jitter(backoff))
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-deadline.C:
			timer.Stop()
			return nil, ErrTimeout
		}
		backoff *= 2
		if backoff > r.maxBackoff {
			backoff = r.maxBackoff
		}
	}
}

func newToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// jitter adds up to 50% of d so replicas that lost the same race do not retry in lockstep.
func jitter(d time.Duration) time.Duration {
	b := make([]byte, 1)
	_, _ = rand.Read(b)
	return d + time.Duration(int64(d)*int64(b[0])/512)
}

package state

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"
)

// In-memory implementations for tests and single-process tools. They store the same JSON
// text the Postgres implementations store, so values round-trip identically (numbers become
// float64, nil maps become empty). They are NOT safe for multi-replica use.

// MemorySessions implements Sessions.
type MemorySessions struct {
	mu   sync.Mutex
	rows map[string]*memSession
	Now  func() time.Time // nil = time.Now
}

type memSession struct {
	context, temp, session []byte
	ctxExp, sessExp        *time.Time
	created, modified      time.Time
}

// NewMemorySessions returns an empty in-memory Sessions store.
func NewMemorySessions() *MemorySessions {
	return &MemorySessions{rows: map[string]*memSession{}}
}

func (s *MemorySessions) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now().UTC()
}

func (s *MemorySessions) toDialogSession(id string, r *memSession) (*DialogSession, error) {
	ctxMap, err := unmarshalMap(r.context)
	if err != nil {
		return nil, err
	}
	tempMap, err := unmarshalMap(r.temp)
	if err != nil {
		return nil, err
	}
	sessMap, err := unmarshalMap(r.session)
	if err != nil {
		return nil, err
	}
	return &DialogSession{
		ID: id, Context: ctxMap, TempData: tempMap, SessionData: sessMap,
		ContextExpiry: copyTime(r.ctxExp), SessionExpiry: copyTime(r.sessExp),
		CreatedOn: r.created, ModifiedOn: r.modified,
	}, nil
}

func (s *MemorySessions) GetOrCreate(_ context.Context, id string) (*DialogSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.rows[id]; ok {
		return s.toDialogSession(id, r)
	}
	now := s.now()
	empty, _ := marshalJS(map[string]any{})
	sd, _ := marshalJS(defaultSessionData())
	r := &memSession{context: empty, temp: empty, session: sd, created: now, modified: now}
	s.rows[id] = r
	return s.toDialogSession(id, r)
}

func (s *MemorySessions) Get(_ context.Context, id string) (*DialogSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rows[id]
	if !ok {
		return nil, nil
	}
	return s.toDialogSession(id, r)
}

// Update ports SessionRepository.update: writes all data columns and modified_on = now.
// Like the legacy UPDATE, a missing row is a silent no-op.
func (s *MemorySessions) Update(_ context.Context, d *DialogSession) error {
	ctxB, err := marshalJS(orEmpty(d.Context))
	if err != nil {
		return err
	}
	tempB, err := marshalJS(orEmpty(d.TempData))
	if err != nil {
		return err
	}
	sessB, err := marshalJS(orEmpty(d.SessionData))
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rows[d.ID]
	if !ok {
		return nil
	}
	r.context, r.temp, r.session = ctxB, tempB, sessB
	r.ctxExp, r.sessExp = copyTime(d.ContextExpiry), copyTime(d.SessionExpiry)
	r.modified = s.now()
	return nil
}

func (s *MemorySessions) Delete(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.rows, id)
	return nil
}

// ExpiredContextIDs ports getExpiredContextSessionIds: context_expiry < now, context <> '{}',
// ordered by modified_on, at most 250 ids.
func (s *MemorySessions) ExpiredContextIDs(_ context.Context, now time.Time) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	type cand struct {
		id       string
		modified time.Time
	}
	var cands []cand
	for id, r := range s.rows {
		if r.ctxExp == nil || !r.ctxExp.Before(now) || string(r.context) == "{}" {
			continue
		}
		cands = append(cands, cand{id, r.modified})
	}
	sort.Slice(cands, func(i, j int) bool {
		if !cands[i].modified.Equal(cands[j].modified) {
			return cands[i].modified.Before(cands[j].modified)
		}
		return cands[i].id < cands[j].id
	})
	if len(cands) > 250 {
		cands = cands[:250]
	}
	ids := make([]string, 0, len(cands))
	for _, c := range cands {
		ids = append(ids, c.id)
	}
	return ids, nil
}

// DeleteExpired ports deleteExpiredSessions: session_expiry < now. NULL expiry is kept.
func (s *MemorySessions) DeleteExpired(_ context.Context, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, r := range s.rows {
		if r.sessExp != nil && r.sessExp.Before(now) {
			delete(s.rows, id)
		}
	}
	return nil
}

// MemoryUsers implements Users.
type MemoryUsers struct {
	mu   sync.Mutex
	rows map[string][]byte
}

// NewMemoryUsers returns an empty in-memory Users store.
func NewMemoryUsers() *MemoryUsers {
	return &MemoryUsers{rows: map[string][]byte{}}
}

func userKey(channel, userID string) string {
	return strings.ToLower(channel) + "\x00" + userID
}

// GetOrCreate ports ChannelUserRepository.getOrCreate: channel is lower-cased, a new user gets {}.
func (u *MemoryUsers) GetOrCreate(_ context.Context, channel, userID string) (map[string]any, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	k := userKey(channel, userID)
	if b, ok := u.rows[k]; ok {
		m, err := unmarshalMap(b)
		if err != nil {
			return nil, err
		}
		return orEmpty(m), nil
	}
	b, err := marshalJS(map[string]any{})
	if err != nil {
		return nil, err
	}
	u.rows[k] = b
	return map[string]any{}, nil
}

// SetAttributes ports ChannelUserRepository.setAttributes (channel lower-cased; unknown user is a no-op).
func (u *MemoryUsers) SetAttributes(_ context.Context, channel, userID string, attributes map[string]any) error {
	b, err := marshalJS(orEmpty(attributes))
	if err != nil {
		return err
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	k := userKey(channel, userID)
	if _, ok := u.rows[k]; ok {
		u.rows[k] = b
	}
	return nil
}

// MemoryKVS implements KVS and KeyLikeDeleter.
type MemoryKVS struct {
	mu   sync.Mutex
	rows map[memKVSKey]memKV
	Now  func() time.Time // nil = time.Now
}

type memKVSKey struct{ botID, key string }

type memKV struct {
	value []byte
	exp   *time.Time
}

// NewMemoryKVS returns an empty in-memory KVS.
func NewMemoryKVS() *MemoryKVS {
	return &MemoryKVS{rows: map[memKVSKey]memKV{}}
}

func (k *MemoryKVS) now() time.Time {
	if k.Now != nil {
		return k.Now()
	}
	return time.Now()
}

func botOrGlobal(botID string) string {
	if botID == "" {
		return globalBotID
	}
	return botID
}

// Get ports KvsService.get: an expired row is deleted and reported as absent.
func (k *MemoryKVS) Get(_ context.Context, botID, key string) (any, bool, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	mk := memKVSKey{botOrGlobal(botID), key}
	r, ok := k.rows[mk]
	if !ok {
		return nil, false, nil
	}
	if r.exp != nil && k.now().After(*r.exp) {
		delete(k.rows, mk)
		return nil, false, nil
	}
	v, err := unmarshalJS(r.value)
	if err != nil {
		return nil, false, err
	}
	return v, true, nil
}

// Set ports KvsService.set/_upsert. expiry <= 0 stores expireOn = NULL.
func (k *MemoryKVS) Set(_ context.Context, botID, key string, value any, expiry time.Duration) error {
	b, err := marshalJS(value)
	if err != nil {
		return err
	}
	var exp *time.Time
	if expiry > 0 {
		t := k.now().Add(expiry)
		exp = &t
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	k.rows[memKVSKey{botOrGlobal(botID), key}] = memKV{value: b, exp: exp}
	return nil
}

// Delete ports KvsService.delete (scoped to botId).
func (k *MemoryKVS) Delete(_ context.Context, botID, key string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	delete(k.rows, memKVSKey{botOrGlobal(botID), key})
	return nil
}

// DeleteKeysLike ports removeStorageKeysStartingWith: LIKE on key only, across all bots.
func (k *MemoryKVS) DeleteKeysLike(_ context.Context, pattern string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	for mk := range k.rows {
		if likeMatch(pattern, mk.key) {
			delete(k.rows, mk)
		}
	}
	return nil
}

// likeMatch implements SQL LIKE with the default escape character backslash.
func likeMatch(pattern, s string) bool {
	p := []rune(pattern)
	t := []rune(s)
	return likeRec(p, t)
}

func likeRec(p, t []rune) bool {
	for len(p) > 0 {
		switch p[0] {
		case '%':
			for len(p) > 0 && p[0] == '%' {
				p = p[1:]
			}
			if len(p) == 0 {
				return true
			}
			for i := 0; i <= len(t); i++ {
				if likeRec(p, t[i:]) {
					return true
				}
			}
			return false
		case '_':
			if len(t) == 0 {
				return false
			}
			p, t = p[1:], t[1:]
		case '\\':
			if len(p) > 1 {
				p = p[1:]
			}
			fallthrough
		default:
			if len(t) == 0 || t[0] != p[0] {
				return false
			}
			p, t = p[1:], t[1:]
		}
	}
	return len(t) == 0
}

func copyTime(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	c := t.UTC()
	return &c
}

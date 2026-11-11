package state

import (
	"context"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"
)

// Postgres implementations. Table and column names, json columns (json, not jsonb) and
// timestamptz columns follow the legacy bootstrap (
//) so legacy can keep reading and writing the same rows (rollback requirement).
// Schema creation is done by legacy; EnsureSchema exists for tests and fresh databases.

// EnsureSchema creates the three tables with the legacy column types if they do not exist.
func EnsureSchema(ctx context.Context, db *gorm.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS dialog_sessions (
			id text NOT NULL,
			context json NOT NULL,
			temp_data json NOT NULL,
			session_data json NOT NULL,
			context_expiry timestamptz NULL,
			session_expiry timestamptz NULL,
			created_on timestamptz NOT NULL,
			modified_on timestamptz NOT NULL,
			PRIMARY KEY (id))`,
		`CREATE TABLE IF NOT EXISTS srv_channel_users (
			id serial PRIMARY KEY,
			channel varchar(255),
			user_id varchar(255),
			attributes json,
			created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE INDEX IF NOT EXISTS scu_idx ON srv_channel_users (channel, user_id)`,
		`CREATE TABLE IF NOT EXISTS srv_kvs (
			key varchar(255),
			value text NOT NULL,
			"botId" varchar(255) NOT NULL,
			"expireOn" timestamptz NULL,
			modified_on timestamptz,
			PRIMARY KEY (key, "botId"))`,
	}
	for _, s := range stmts {
		if err := db.WithContext(ctx).Exec(s).Error; err != nil {
			return fmt.Errorf("state: ensure schema: %w", err)
		}
	}
	return nil
}

// PostgresSessions implements Sessions on dialog_sessions.
type PostgresSessions struct {
	db  *gorm.DB
	Now func() time.Time // nil = time.Now
}

// NewPostgresSessions wraps db.
func NewPostgresSessions(db *gorm.DB) *PostgresSessions { return &PostgresSessions{db: db} }

func (s *PostgresSessions) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now().UTC()
}

type sessionRow struct {
	ID            string     `gorm:"column:id"`
	Context       string     `gorm:"column:context"`
	TempData      string     `gorm:"column:temp_data"`
	SessionData   string     `gorm:"column:session_data"`
	ContextExpiry *time.Time `gorm:"column:context_expiry"`
	SessionExpiry *time.Time `gorm:"column:session_expiry"`
	CreatedOn     time.Time  `gorm:"column:created_on"`
	ModifiedOn    time.Time  `gorm:"column:modified_on"`
}

const sessionSelect = `SELECT id, context::text AS context, temp_data::text AS temp_data,
	session_data::text AS session_data, context_expiry, session_expiry, created_on, modified_on
	FROM dialog_sessions WHERE id = ?`

// GetOrCreate ports SessionRepository.getOrCreateSession + insert (defaults: context {},
// temp_data {}, session_data {lastMessages: [], workflows: {}}, expiry NULL).
func (s *PostgresSessions) GetOrCreate(ctx context.Context, id string) (*DialogSession, error) {
	sd, err := marshalJS(defaultSessionData())
	if err != nil {
		return nil, err
	}
	now := s.now()
	err = s.db.WithContext(ctx).Exec(`INSERT INTO dialog_sessions
		(id, context, temp_data, session_data, context_expiry, session_expiry, created_on, modified_on)
		VALUES (?, '{}'::json, '{}'::json, ?::json, NULL, NULL, ?, ?)
		ON CONFLICT (id) DO NOTHING`, id, string(sd), now, now).Error
	if err != nil {
		return nil, fmt.Errorf("state: insert session: %w", err)
	}
	got, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if got == nil {
		return nil, fmt.Errorf("state: session %q missing after insert", id)
	}
	return got, nil
}

func (s *PostgresSessions) Get(ctx context.Context, id string) (*DialogSession, error) {
	var row sessionRow
	if err := s.db.WithContext(ctx).Raw(sessionSelect, id).Scan(&row).Error; err != nil {
		return nil, fmt.Errorf("state: get session: %w", err)
	}
	if row.ID == "" {
		return nil, nil
	}
	ctxMap, err := unmarshalMap([]byte(row.Context))
	if err != nil {
		return nil, err
	}
	tempMap, err := unmarshalMap([]byte(row.TempData))
	if err != nil {
		return nil, err
	}
	sessMap, err := unmarshalMap([]byte(row.SessionData))
	if err != nil {
		return nil, err
	}
	return &DialogSession{
		ID: row.ID, Context: ctxMap, TempData: tempMap, SessionData: sessMap,
		ContextExpiry: copyTime(row.ContextExpiry), SessionExpiry: copyTime(row.SessionExpiry),
		CreatedOn: row.CreatedOn, ModifiedOn: row.ModifiedOn,
	}, nil
}

// Update ports SessionRepository.update (modified_on = now).
func (s *PostgresSessions) Update(ctx context.Context, d *DialogSession) error {
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
	return s.db.WithContext(ctx).Exec(`UPDATE dialog_sessions SET
		context = ?::json, temp_data = ?::json, session_data = ?::json,
		context_expiry = ?, session_expiry = ?, modified_on = ?
		WHERE id = ?`,
		string(ctxB), string(tempB), string(sessB),
		timeOrNil(d.ContextExpiry), timeOrNil(d.SessionExpiry), s.now(), d.ID).Error
}

func (s *PostgresSessions) Delete(ctx context.Context, id string) error {
	return s.db.WithContext(ctx).Exec(`DELETE FROM dialog_sessions WHERE id = ?`, id).Error
}

// ExpiredContextIDs ports getExpiredContextSessionIds (limit 250, order by modified_on).
func (s *PostgresSessions) ExpiredContextIDs(ctx context.Context, now time.Time) ([]string, error) {
	var ids []string
	err := s.db.WithContext(ctx).Raw(`SELECT id FROM dialog_sessions
		WHERE context_expiry < ? AND context::text <> '{}'::text
		ORDER BY modified_on LIMIT 250`, now).Scan(&ids).Error
	if err != nil {
		return nil, fmt.Errorf("state: expired context ids: %w", err)
	}
	return ids, nil
}

// DeleteExpired ports deleteExpiredSessions (session_expiry < now).
func (s *PostgresSessions) DeleteExpired(ctx context.Context, now time.Time) error {
	return s.db.WithContext(ctx).Exec(`DELETE FROM dialog_sessions WHERE session_expiry < ?`, now).Error
}

// PostgresUsers implements Users on srv_channel_users.
type PostgresUsers struct {
	db *gorm.DB
}

// NewPostgresUsers wraps db.
func NewPostgresUsers(db *gorm.DB) *PostgresUsers { return &PostgresUsers{db: db} }

// GetOrCreate ports ChannelUserRepository.getOrCreate (without the bot_chat_users batch,
// which needs a botId the Users contract does not carry; see report).
func (u *PostgresUsers) GetOrCreate(ctx context.Context, channel, userID string) (map[string]any, error) {
	channel = strings.ToLower(channel)
	var raw []struct {
		Attributes *string `gorm:"column:attributes"`
	}
	err := u.db.WithContext(ctx).Raw(`SELECT attributes::text AS attributes FROM srv_channel_users
		WHERE channel = ? AND user_id = ? LIMIT 1`, channel, userID).Scan(&raw).Error
	if err != nil {
		return nil, fmt.Errorf("state: get user: %w", err)
	}
	if len(raw) > 0 {
		var b []byte
		if raw[0].Attributes != nil {
			b = []byte(*raw[0].Attributes)
		}
		m, err := unmarshalMap(b)
		if err != nil {
			return nil, err
		}
		return orEmpty(m), nil
	}
	err = u.db.WithContext(ctx).Exec(`INSERT INTO srv_channel_users
		(channel, user_id, attributes, created_at, updated_at)
		VALUES (?, ?, '{}'::json, ?, ?)`, channel, userID, time.Now().UTC(), time.Now().UTC()).Error
	if err != nil {
		return nil, fmt.Errorf("state: insert user: %w", err)
	}
	return map[string]any{}, nil
}

// SetAttributes ports ChannelUserRepository.setAttributes (channel lower-cased). updated_at is
// not touched, as in legacy (knex does not set it on update).
func (u *PostgresUsers) SetAttributes(ctx context.Context, channel, userID string, attributes map[string]any) error {
	b, err := marshalJS(orEmpty(attributes))
	if err != nil {
		return err
	}
	return u.db.WithContext(ctx).Exec(`UPDATE srv_channel_users SET attributes = ?::json
		WHERE channel = ? AND user_id = ?`, string(b), strings.ToLower(channel), userID).Error
}

// PostgresKVS implements KVS and KeyLikeDeleter on srv_kvs.
type PostgresKVS struct {
	db  *gorm.DB
	Now func() time.Time // nil = time.Now
}

// NewPostgresKVS wraps db.
func NewPostgresKVS(db *gorm.DB) *PostgresKVS { return &PostgresKVS{db: db} }

func (k *PostgresKVS) now() time.Time {
	if k.Now != nil {
		return k.Now()
	}
	return time.Now()
}

// Get ports KvsService.get: an expired row is deleted and reported as absent.
func (k *PostgresKVS) Get(ctx context.Context, botID, key string) (any, bool, error) {
	bid := botOrGlobal(botID)
	var rows []struct {
		Value    string     `gorm:"column:value"`
		ExpireOn *time.Time `gorm:"column:expireOn"`
	}
	err := k.db.WithContext(ctx).Raw(`SELECT value, "expireOn" FROM srv_kvs
		WHERE "botId" = ? AND key = ? LIMIT 1`, bid, key).Scan(&rows).Error
	if err != nil {
		return nil, false, fmt.Errorf("state: kvs get: %w", err)
	}
	if len(rows) == 0 {
		return nil, false, nil
	}
	if rows[0].ExpireOn != nil && k.now().After(*rows[0].ExpireOn) {
		if err := k.Delete(ctx, botID, key); err != nil {
			return nil, false, err
		}
		return nil, false, nil
	}
	v, err := unmarshalJS([]byte(rows[0].Value))
	if err != nil {
		return nil, false, err
	}
	return v, true, nil
}

// Set ports KvsService.set/_upsert: INSERT... ON CONFLICT (key, "botId") DO UPDATE.
func (k *PostgresKVS) Set(ctx context.Context, botID, key string, value any, expiry time.Duration) error {
	b, err := marshalJS(value)
	if err != nil {
		return err
	}
	var exp any
	if expiry > 0 {
		exp = k.now().Add(expiry)
	}
	now := time.Now().UTC()
	return k.db.WithContext(ctx).Exec(`INSERT INTO srv_kvs ("botId", key, value, "expireOn", modified_on)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (key, "botId") DO UPDATE
		SET value = EXCLUDED.value, modified_on = EXCLUDED.modified_on, "expireOn" = EXCLUDED."expireOn"`,
		botOrGlobal(botID), key, string(b), exp, now).Error
}

// Delete ports KvsService.delete (scoped to botId).
func (k *PostgresKVS) Delete(ctx context.Context, botID, key string) error {
	return k.db.WithContext(ctx).Exec(`DELETE FROM srv_kvs WHERE "botId" = ? AND key = ?`,
		botOrGlobal(botID), key).Error
}

// DeleteKeysLike ports removeStorageKeysStartingWith: `key LIKE pattern` with NO botId filter.
func (k *PostgresKVS) DeleteKeysLike(ctx context.Context, pattern string) error {
	return k.db.WithContext(ctx).Exec(`DELETE FROM srv_kvs WHERE key LIKE ?`, pattern).Error
}

func timeOrNil(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC()
}

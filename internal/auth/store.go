package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
)

// User is one row of strategy_<strategy> (legacy StrategyUserTable).
type User struct {
	Email        string
	Strategy     string
	Password     string
	Salt         string
	TokenVersion int
	Attributes   map[string]any
}

// UserStore reads and updates strategy users.
type UserStore interface {
	// FindUser returns (nil, nil) when the user does not exist.
	FindUser(ctx context.Context, email, strategy string) (*User, error)
	// PatchAttributes merges patch into the user's attributes. A nil value deletes the key.
	PatchAttributes(ctx context.Context, email, strategy string, patch map[string]any) error
}

// PGUserStore uses the legacy strategy table. Table name is strategy_<strategy>.
// attributes is a `json` (not jsonb) column, so updates are read-modify-write
// inside a transaction with a row lock.
type PGUserStore struct {
	DB *gorm.DB
}

func tableFor(strategy string) (string, error) {
	if strategy == "" {
		return "", errors.New("auth: empty strategy")
	}
	for _, r := range strategy {
		if !(r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')) {
			return "", fmt.Errorf("auth: invalid strategy %q", strategy)
		}
	}
	return "strategy_" + strategy, nil
}

type userRow struct {
	Email        string          `gorm:"column:email"`
	Strategy     string          `gorm:"column:strategy"`
	Password     *string         `gorm:"column:password"`
	Salt         *string         `gorm:"column:salt"`
	TokenVersion int             `gorm:"column:tokenVersion"`
	Attributes   json.RawMessage `gorm:"column:attributes"`
}

func (u userRow) toUser() (*User, error) {
	attrs := map[string]any{}
	if len(u.Attributes) > 0 {
		if err := json.Unmarshal(u.Attributes, &attrs); err != nil {
			return nil, fmt.Errorf("auth: bad attributes for %s: %w", u.Email, err)
		}
	}
	out := &User{Email: u.Email, Strategy: u.Strategy, TokenVersion: u.TokenVersion, Attributes: attrs}
	if u.Password != nil {
		out.Password = *u.Password
	}
	if u.Salt != nil {
		out.Salt = *u.Salt
	}
	return out, nil
}

// FindUser implements UserStore.
func (s *PGUserStore) FindUser(ctx context.Context, email, strategy string) (*User, error) {
	table, err := tableFor(strategy)
	if err != nil {
		return nil, err
	}
	var row userRow
	err = s.DB.WithContext(ctx).Table(table).
		Where("email = ? AND strategy = ?", email, strategy).
		Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("auth: find user: %w", err)
	}
	return row.toUser()
}

// PatchAttributes implements UserStore.
func (s *PGUserStore) PatchAttributes(ctx context.Context, email, strategy string, patch map[string]any) error {
	table, err := tableFor(strategy)
	if err != nil {
		return err
	}
	return s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row userRow
		err := tx.Table(table).Select("email", "strategy", "attributes").
			Where("email = ? AND strategy = ?", email, strategy).
			Clauses(lockForUpdate()).Take(&row).Error
		if err != nil {
			return fmt.Errorf("auth: lock user: %w", err)
		}
		u, err := row.toUser()
		if err != nil {
			return err
		}
		for k, v := range patch {
			if v == nil {
				delete(u.Attributes, k)
			} else {
				u.Attributes[k] = v
			}
		}
		b, err := json.Marshal(u.Attributes)
		if err != nil {
			return err
		}
		return tx.Table(table).Where("email = ? AND strategy = ?", email, strategy).
			Update("attributes", string(b)).Error
	})
}

// parseTime reads an attribute stored as an ISO 8601 string (what JS Date.toJSON writes).
func parseTime(v any) (time.Time, bool) {
	s, ok := v.(string)
	if !ok {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

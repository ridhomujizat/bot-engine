package auth

import (
	"context"
	"os"
	"testing"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// TestPGUserStore needs BOTFS_TEST_DSN (any Postgres database; the test creates
// strategy_default_test-style table strategy_default in that database only if missing).
func TestPGUserStore(t *testing.T) {
	dsn := os.Getenv("BOTFS_TEST_DSN")
	if dsn == "" {
		t.Skip("BOTFS_TEST_DSN not set")
	}
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	defer sqlDB.Close()

	// Same column layout as the legacy strategy table (strategy_default).
	if err := db.Exec(`CREATE TABLE IF NOT EXISTS strategy_default (
		id serial PRIMARY KEY, email varchar(255) NOT NULL, password varchar(255), salt varchar(255),
		strategy varchar(255) NOT NULL, attributes json NOT NULL, "tokenVersion" integer NOT NULL DEFAULT 1,
		created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`).Error; err != nil {
		t.Fatal(err)
	}
	email := "store-test@example.com"
	db.Exec(`DELETE FROM strategy_default WHERE email = ?`, email)
	if err := db.Exec(`INSERT INTO strategy_default (email, password, salt, strategy, attributes, "tokenVersion")
		VALUES (?, ?, ?, 'default', '{"unsuccessful_logins":1,"last_login_attempt":"2026-11-11T10:00:00Z"}', 2)`,
		email, vecHash, vecSalt).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Exec(`DELETE FROM strategy_default WHERE email = ?`, email) })

	store := &PGUserStore{DB: db}
	ctx := context.Background()
	u, err := store.FindUser(ctx, email, "default")
	if err != nil || u == nil {
		t.Fatalf("find: %v %v", u, err)
	}
	if u.TokenVersion != 2 || !VerifyPassword(vecPW, u.Password, u.Salt) {
		t.Fatalf("user fields: %+v", u)
	}
	if none, err := store.FindUser(ctx, "nobody@example.com", "default"); err != nil || none != nil {
		t.Fatalf("missing user: %v %v", none, err)
	}

	if err := store.PatchAttributes(ctx, email, "default", map[string]any{
		"unsuccessful_logins": 0, "last_login_attempt": nil, "locked_out": false,
	}); err != nil {
		t.Fatal(err)
	}
	u, _ = store.FindUser(ctx, email, "default")
	if n, _ := toInt(u.Attributes["unsuccessful_logins"]); n != 0 {
		t.Fatalf("counter not reset: %v", u.Attributes)
	}
	if _, present := u.Attributes["last_login_attempt"]; present {
		t.Fatal("nil patch must delete the key")
	}
	if _, ok := u.Attributes["locked_out"]; !ok {
		t.Fatal("locked_out not written")
	}
}

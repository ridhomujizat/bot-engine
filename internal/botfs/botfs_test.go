package botfs

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// contract runs the Store behaviour shared by Disk and PG.
func contract(t *testing.T, s Store, bot string) {
	t.Helper()
	ctx := context.Background()
	cx := "data/bots/" + bot + "/"
	cy := "data/bots/" + bot + "y/"

	if _, err := s.ReadFile(ctx, cx+"missing.json"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing file: want ErrNotFound, got %v", err)
	}
	if err := s.WriteFile(ctx, cx+"flows/a.flow.json", []byte(`{"a":1}`)); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteFile(ctx, cx+"flows/a.flow.json", []byte(`{"a":2}`)); err != nil {
		t.Fatal(err)
	}
	b, err := s.ReadFile(ctx, cx+"flows/a.flow.json")
	if err != nil || string(b) != `{"a":2}` {
		t.Fatalf("read after upsert: %q %v", b, err)
	}
	if err := s.WriteFile(ctx, cx+"flows/b.flow.json", []byte("b")); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteFile(ctx, cy+"bot.config.json", []byte("{}")); err != nil {
		t.Fatal(err)
	}

	files, err := s.ListFiles(ctx, cx)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 || files[0].Path != cx+"flows/a.flow.json" || files[1].Path != cx+"flows/b.flow.json" {
		t.Fatalf("list: %+v", files)
	}

	lm, err := s.LastModified(ctx, cx)
	if err != nil || lm.IsZero() {
		t.Fatalf("last modified: %v %v", lm, err)
	}

	if err := s.DeleteFile(ctx, cx+"flows/b.flow.json"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadFile(ctx, cx+"flows/b.flow.json"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted file readable: %v", err)
	}
	files, _ = s.ListFiles(ctx, cx)
	if len(files) != 1 {
		t.Fatalf("deleted file still listed: %+v", files)
	}
	if err := s.DeleteFile(ctx, cx+"flows/nope.json"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete missing: want ErrNotFound, got %v", err)
	}
}

func TestDiskContract(t *testing.T) {
	contract(t, NewDisk(t.TempDir()), "cx")
}

func TestDiskRejectsEmptyPath(t *testing.T) {
	d := NewDisk(t.TempDir())
	if err := d.WriteFile(context.Background(), "/", []byte("x")); err == nil {
		t.Fatal("expected error for root path")
	}
}

// TestPGContract runs against a Postgres database when BOTFS_TEST_DSN is set,
// e.g. a throwaway cluster started by `initdb` + `pg_ctl`. The test creates the
// two ghost tables if missing and only touches paths under a unique bot id.
func TestPGContract(t *testing.T) {
	dsn := os.Getenv("BOTFS_TEST_DSN")
	if dsn == "" {
		t.Skip("BOTFS_TEST_DSN not set")
	}
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })

	mustExec(t, db, `CREATE TABLE IF NOT EXISTS srv_ghost_files (file_path varchar(255) PRIMARY KEY, content bytea, deleted boolean, modified_on timestamptz)`)
	mustExec(t, db, `CREATE TABLE IF NOT EXISTS srv_ghost_index (file_path varchar(255), revision varchar(255), created_by varchar(255), created_on timestamptz, PRIMARY KEY (file_path, revision))`)

	botID := "pgtest" + time.Now().Format("150405")
	t.Cleanup(func() {
		mustExec(t, db, `DELETE FROM srv_ghost_files WHERE file_path LIKE ?`, "data/bots/"+botID+"/%")
		mustExec(t, db, `DELETE FROM srv_ghost_index WHERE file_path LIKE ?`, "data/bots/"+botID+"/%")
	})

	// Rewrite the contract's fixed bot ids to the unique one.
	contract(t, NewPG(db), botID)
}

func mustExec(t *testing.T, db *gorm.DB, sql string, args ...any) {
	t.Helper()
	if err := db.Exec(sql, args...).Error; err != nil {
		t.Fatal(err)
	}
}

func TestIsOSJunk(t *testing.T) {
	junk := []string{"._builtin_card.json", "e2e-worker/._content-elements", "x/.DS_Store", "__MACOSX/a.json", "bot/__MACOSX/b.json"}
	keep := []string{"flows/main.flow.json", "actions/_private.js", "content-elements/builtin_text.json", "flows/my._x.json"}
	for _, p := range junk {
		if !IsOSJunk(p) {
			t.Errorf("IsOSJunk(%q) = false, want true", p)
		}
	}
	for _, p := range keep {
		if IsOSJunk(p) {
			t.Errorf("IsOSJunk(%q) = true, want false", p)
		}
	}
}

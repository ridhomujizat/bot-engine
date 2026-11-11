package state

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// startPostgres boots a throwaway cluster with initdb/pg_ctl (postgresql_16 from the nix
// devshell). The test is skipped when the tools are not on PATH.
func startPostgres(t *testing.T) *gorm.DB {
	t.Helper()
	initdb, err1 := exec.LookPath("initdb")
	pgctl, err2 := exec.LookPath("pg_ctl")
	if err1 != nil || err2 != nil {
		t.Skip("postgres tools (initdb, pg_ctl) not on PATH; run inside `nix develop`")
	}

	port := freePort(t)
	dir, err := os.MkdirTemp("", "pgstate")
	if err != nil {
		t.Fatal(err)
	}
	dataDir := filepath.Join(dir, "data")
	run := func(name string, args ...string) {
		t.Helper()
		out, err := exec.Command(name, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("%s %v: %v\n%s", name, args, err, out)
		}
	}
	run(initdb, "-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-locale")
	run(pgctl, "-D", dataDir, "-l", filepath.Join(dir, "log"), "-w", "-o",
		fmt.Sprintf("-p %d -h 127.0.0.1 -k %s", port, dir), "start")
	t.Cleanup(func() {
		_ = exec.Command(pgctl, "-D", dataDir, "-m", "fast", "-w", "stop").Run()
		_ = os.RemoveAll(dir)
	})

	dsn := fmt.Sprintf("host=127.0.0.1 port=%d user=postgres dbname=postgres sslmode=disable", port)
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	return db
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func TestPostgresStateManager(t *testing.T) {
	db := startPostgres(t)
	ctx := context.Background()
	if err := EnsureSchema(ctx, db); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	clk := func() time.Time { return now }

	kvs := NewPostgresKVS(db)
	kvs.Now = clk
	sess := NewPostgresSessions(db)
	sess.Now = clk
	m := &Manager{Sessions: sess, Users: NewPostgresUsers(db), KVS: kvs, Now: clk}
	suite(t, m)

	t.Run("kvs formats match legacy rows", func(t *testing.T) {
		if err := kvs.Set(ctx, "pgbot", "global", map[string]any{"a": "<b>"}, 0); err != nil {
			t.Fatal(err)
		}
		var raw struct {
			Value    string
			BotID    string     `gorm:"column:botId"`
			ExpireOn *time.Time `gorm:"column:expireOn"`
		}
		err := db.Raw(`SELECT value, "botId", "expireOn" FROM srv_kvs WHERE key = 'global' AND "botId" = 'pgbot'`).Scan(&raw).Error
		if err != nil {
			t.Fatal(err)
		}
		if raw.Value != `{"a":"<b>"}` || raw.ExpireOn != nil {
			t.Errorf("row = %+v", raw)
		}
	})

	t.Run("global kvs uses __global__ botId", func(t *testing.T) {
		if err := kvs.Set(ctx, "", "gkey", "v", 0); err != nil {
			t.Fatal(err)
		}
		var n int64
		db.Raw(`SELECT count(*) FROM srv_kvs WHERE "botId" = '__global__' AND key = 'gkey'`).Scan(&n)
		if n != 1 {
			t.Errorf("global row count = %d", n)
		}
	})

	t.Run("legacy-written session row is readable", func(t *testing.T) {
		err := db.Exec(`INSERT INTO dialog_sessions (id, context, temp_data, session_data, context_expiry, session_expiry, created_on, modified_on)
			VALUES ('legacybot::web::legacy', '{"flow":"main.flow.json"}', '{"skill-x":true}', '{"lastMessages":[{"a":1}],"workflows":{}}',
			now() + interval '1 hour', now() + interval '2 hours', now(), now())`).Error
		if err != nil {
			t.Fatal(err)
		}
		ev := map[string]any{"botId": "legacybot", "channel": "web", "target": "legacy"}
		if err := m.Restore(ctx, ev, DefaultConfig()); err != nil {
			t.Fatal(err)
		}
		st := ev["state"].(map[string]any)
		if st["context"].(map[string]any)["flow"] != "main.flow.json" {
			t.Errorf("context = %#v", st["context"])
		}
		if st["temp"].(map[string]any)["skill-x"] != true {
			t.Errorf("temp = %#v", st["temp"])
		}
	})

	t.Run("ExpiredContextIDs and DeleteExpired use timestamptz", func(t *testing.T) {
		err := db.Exec(`INSERT INTO dialog_sessions (id, context, temp_data, session_data, context_expiry, session_expiry, created_on, modified_on)
			VALUES ('exp::web::x', '{"f":1}', '{}', '{}', $1, $2, now(), now())`,
			now.Add(-time.Minute), now.Add(-time.Minute)).Error
		if err != nil {
			t.Fatal(err)
		}
		ids, err := sess.ExpiredContextIDs(ctx, now)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, id := range ids {
			if id == "exp::web::x" {
				found = true
			}
		}
		if !found {
			t.Errorf("expired id not returned: %v", ids)
		}
		if err := sess.DeleteExpired(ctx, now); err != nil {
			t.Fatal(err)
		}
		if got, _ := sess.Get(ctx, "exp::web::x"); got != nil {
			t.Errorf("expired session not deleted")
		}
	})

	_ = strconv.Itoa
}

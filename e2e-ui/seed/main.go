// Command seed prepares a fresh tenant database for the editor e2e run:
// the legacy tables bot-engine reads (srv_ghost_files, srv_ghost_index, the basic
// strategy table strategy_default), the engine's own tables, and one login.
//
//	go run./e2e-ui/seed -dsn "postgres://..." -email e2e@example.com -password '...'
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/ridhomujizat/bot-engine/internal/auth"
	"github.com/ridhomujizat/bot-engine/internal/state"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

const ddl = `
CREATE TABLE IF NOT EXISTS srv_ghost_files (file_path varchar(255) PRIMARY KEY, content bytea, deleted boolean, modified_on timestamptz);
CREATE TABLE IF NOT EXISTS srv_ghost_index (file_path varchar(255), revision varchar(255), created_by varchar(255), created_on timestamptz, PRIMARY KEY (file_path, revision));
CREATE TABLE IF NOT EXISTS strategy_default (
	id serial PRIMARY KEY, email varchar(255) NOT NULL, password varchar(255), salt varchar(255),
	strategy varchar(255) NOT NULL, attributes json NOT NULL, "tokenVersion" integer NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
`

func main() {
	dsn := flag.String("dsn", os.Getenv("DATABASE_URL"), "tenant Postgres URL")
	email := flag.String("email", "e2e@example.com", "login email")
	password := flag.String("password", "", "login password")
	salt := flag.String("salt", "0123456789abcdef", "legacy-style salt (16 hex chars)")
	flag.Parse()
	if *dsn == "" || *password == "" {
		log.Fatal("seed: -dsn and -password are required")
	}

	db, err := gorm.Open(postgres.Open(*dsn), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		log.Fatal(err)
	}
	ctx := context.Background()
	if err := db.Exec(ddl).Error; err != nil {
		log.Fatalf("seed: ddl: %v", err)
	}
	if err := state.EnsureSchema(ctx, db); err != nil {
		log.Fatalf("seed: engine schema: %v", err)
	}
	db.Exec(`DELETE FROM strategy_default WHERE email = ?`, *email)
	hash := auth.HashPassword(*password, *salt)
	if err := db.Exec(`INSERT INTO strategy_default (email, password, salt, strategy, attributes, "tokenVersion")
		VALUES (?, ?, ?, 'default', '{}', 1)`, *email, hash, *salt).Error; err != nil {
		log.Fatalf("seed: user: %v", err)
	}
	fmt.Println("seed: ok")
}

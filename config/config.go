// Package config loads bot-engine settings from the environment and from the
// tenant's legacy.config.json (data/global/, read through botfs).
//
// Env wins over legacy.config.json for every value both define. The app
// secret must be stable across replicas, so it is never generated at runtime
// (legacy generates and persists one when missing; here that would split tokens
// between pods).
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/caarlos0/env/v11"
)

// Config is the process configuration read from environment variables.
type Config struct {
	Port     int    `env:"PORT" envDefault:"3000"`
	LogLevel string `env:"LOG_LEVEL" envDefault:"info"`
	// UserCodeTimeout bounds each action, hook and condition run by bot JavaScript.
	UserCodeTimeout time.Duration `env:"USERCODE_TIMEOUT" envDefault:"30s"`
	ExternalURL     string        `env:"EXTERNAL_URL"`

	// DatabaseURL is a full Postgres URL for the tenant database
	// (e.g. postgres://user:pass@host:5432/bots_tenant?sslmode=disable).
	// When empty, PG_HOST/PG_PORT/PG_USER/PG_PASSWORD/BOT_DB_NAME are used.
	DatabaseURL string `env:"DATABASE_URL"`
	PGHost      string `env:"PG_HOST"`
	PGPort      int    `env:"PG_PORT" envDefault:"5432"`
	PGUser      string `env:"PG_USER"`
	PGPassword  string `env:"PG_PASSWORD"`
	// BotDBName is the tenant legacy database, e.g. bots_{tenant} in prod.
	BotDBName string `env:"BOT_DB_NAME"`
	PGSSLMode string `env:"PG_SSLMODE" envDefault:"disable"`

	// RedisURL enables distributed locks (redis://...). Empty means in-process locks,
	// which is only correct with a single replica.
	RedisURL string `env:"REDIS_URL"`

	// GlobalConfigFile is the global server config file name under data/global/ in the
	// content store. Set it to the file name your existing legacy data uses.
	GlobalConfigFile string `env:"GLOBAL_CONFIG_FILE" envDefault:"legacy.config.json"`

	// BotFSDir serves bot content from a directory instead of srv_ghost_files (tests, dev).
	BotFSDir string `env:"BOTFS_DIR"`

	// AppSecret signs collaborator JWTs. Falls back to appSecret/jwtSecret in legacy.config.json.
	AppSecret string `env:"APP_SECRET"`

	// Global dialog overrides; empty means use legacy.config.json, then engine defaults.
	DialogTimeoutInterval        string `env:"DIALOG_TIMEOUT_INTERVAL"`
	DialogSessionTimeoutInterval string `env:"DIALOG_SESSION_TIMEOUT_INTERVAL"`
	DialogJanitorInterval        string `env:"DIALOG_JANITOR_INTERVAL"`
}

// Load parses the process environment.
func Load() (Config, error) {
	var c Config
	if err := env.Parse(&c); err != nil {
		return c, fmt.Errorf("config: %w", err)
	}
	return c, nil
}

// DSN returns the Postgres connection string for the tenant database.
func (c Config) DSN() (string, error) {
	if c.DatabaseURL != "" {
		return c.DatabaseURL, nil
	}
	if c.PGHost == "" || c.BotDBName == "" {
		return "", errors.New("config: set DATABASE_URL or PG_HOST and BOT_DB_NAME")
	}
	return fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
		c.PGHost, c.PGPort, c.PGUser, c.PGPassword, c.BotDBName, c.PGSSLMode), nil
}

// LegacyConfig is the subset of data/global/legacy.config.json bot-engine reads.
type LegacyConfig struct {
	AppSecret string `json:"appSecret"`
	JWTSecret string `json:"jwtSecret"`
	Port      int    `json:"port"`
	Dialog    struct {
		TimeoutInterval        string `json:"timeoutInterval"`
		SessionTimeoutInterval string `json:"sessionTimeoutInterval"`
		JanitorInterval        string `json:"janitorInterval"`
	} `json:"dialog"`
	Converse struct {
		Timeout          string `json:"timeout"`
		MaxMessageLength int    `json:"maxMessageLength"`
	} `json:"converse"`
	JWTToken struct {
		Duration string `json:"duration"`
	} `json:"jwtToken"`
	FileUpload struct {
		MaxFileSize      string   `json:"maxFileSize"`
		AllowedMimeTypes []string `json:"allowedMimeTypes"`
	} `json:"fileUpload"`
	AuthStrategies map[string]struct {
		Type    string `json:"type"`
		Options struct {
			MaxLoginAttempt int    `json:"maxLoginAttempt"`
			LockoutDuration string `json:"lockoutDuration"`
		} `json:"options"`
	} `json:"authStrategies"`
	SuperAdmins []struct {
		Email    string `json:"email"`
		Strategy string `json:"strategy"`
	} `json:"superAdmins"`
}

// ParseLegacyConfig decodes legacy.config.json. An empty input yields zero values.
func ParseLegacyConfig(raw []byte) (LegacyConfig, error) {
	var bc LegacyConfig
	if len(strings.TrimSpace(string(raw))) == 0 {
		return bc, nil
	}
	if err := json.Unmarshal(raw, &bc); err != nil {
		return bc, fmt.Errorf("config: parse legacy.config.json: %w", err)
	}
	return bc, nil
}

// ResolveAppSecret returns the JWT signing secret: env first, then the file.
func ResolveAppSecret(envSecret string, bc LegacyConfig) (string, error) {
	for _, s := range []string{envSecret, bc.AppSecret, bc.JWTSecret} {
		if s != "" {
			return s, nil
		}
	}
	return "", errors.New("config: no app secret: set APP_SECRET or appSecret in legacy.config.json")
}

// Command bot-engine runs the legacy replacement: converse API, auth,
// Legacy-compatible editor API and the embedded editor UI.
//
//	bot-engine serve run the HTTP server (default)
//	bot-engine validate [--bot ID] validate one bot, or every bot with --all (default)
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ridhomujizat/bot-engine/config"
	"github.com/ridhomujizat/bot-engine/internal/api"
	"github.com/ridhomujizat/bot-engine/internal/auth"
	"github.com/ridhomujizat/bot-engine/internal/botfs"
	"github.com/ridhomujizat/bot-engine/internal/engine"
	"github.com/ridhomujizat/bot-engine/internal/flow"
	"github.com/ridhomujizat/bot-engine/internal/lock"
	"github.com/ridhomujizat/bot-engine/internal/state"
	"github.com/ridhomujizat/bot-engine/internal/studioapi"
	"github.com/ridhomujizat/bot-engine/internal/usercode"
	"github.com/ridhomujizat/bot-engine/internal/web"

	"github.com/redis/go-redis/v9"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
)

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "bot-engine:", err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	cmd := "serve"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	logger := newLogger(cfg.LogLevel, stderr)

	switch cmd {
	case "serve":
		return serve(cfg, logger)
	case "validate":
		return validateCmd(cfg, args, stdout)
	default:
		return fmt.Errorf("unknown command %q (want serve or validate)", cmd)
	}
}

func newLogger(level string, w io.Writer) *slog.Logger {
	var lv slog.Level
	if err := lv.UnmarshalText([]byte(level)); err != nil {
		lv = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{Level: lv}))
}

// openStore returns the bot content store: srv_ghost_files via the tenant DB, or a directory.
func openStore(cfg config.Config, db *gorm.DB) (botfs.Store, error) {
	if cfg.BotFSDir != "" {
		return botfs.NewDisk(cfg.BotFSDir), nil
	}
	if db == nil {
		return nil, errors.New("no database configured")
	}
	return botfs.NewPG(db), nil
}

func openDB(cfg config.Config) (*gorm.DB, error) {
	dsn, err := cfg.DSN()
	if err != nil {
		return nil, err
	}
	return gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: gormlogger.Default.LogMode(gormlogger.Warn)})
}

// readGlobalConfig loads data/global/<GLOBAL_CONFIG_FILE>; a missing file yields defaults.
func readGlobalConfig(ctx context.Context, store botfs.Store, file string) (config.LegacyConfig, error) {
	raw, err := store.ReadFile(ctx, "data/global/"+file)
	if errors.Is(err, botfs.ErrNotFound) {
		return config.LegacyConfig{}, nil
	}
	if err != nil {
		return config.LegacyConfig{}, err
	}
	return config.ParseLegacyConfig(raw)
}

// globalDialog merges engine defaults < legacy.config.json < env (later wins).
func globalDialog(cfg config.Config, bc config.LegacyConfig) engine.GlobalDialogConfig {
	g := engine.GlobalDialogConfig{
		TimeoutInterval:        "15m",
		SessionTimeoutInterval: "30m",
		JanitorInterval:        "10s",
		ConverseTimeout:        "5s",
		MaxMessageLength:       360,
	}
	pick := func(dst *string, vals ...string) {
		for _, v := range vals {
			if v != "" {
				*dst = v
				return
			}
		}
	}
	pick(&g.TimeoutInterval, bc.Dialog.TimeoutInterval, cfg.DialogTimeoutInterval)
	pick(&g.SessionTimeoutInterval, bc.Dialog.SessionTimeoutInterval, cfg.DialogSessionTimeoutInterval)
	pick(&g.JanitorInterval, bc.Dialog.JanitorInterval, cfg.DialogJanitorInterval)
	pick(&g.ConverseTimeout, bc.Converse.Timeout)
	if bc.Converse.MaxMessageLength > 0 {
		g.MaxMessageLength = bc.Converse.MaxMessageLength
	}
	return g
}

// mediaLimits reads fileUpload from legacy.config.json. Bad sizes fall back to the defaults.
func mediaLimits(bc config.LegacyConfig) studioapi.MediaLimits {
	var l studioapi.MediaLimits
	if n, err := studioapi.ParseSize(bc.FileUpload.MaxFileSize); err == nil {
		l.MaxBytes = n
	}
	l.AllowedMimeTypes = bc.FileUpload.AllowedMimeTypes
	return l
}

// authOptions builds the auth service options from legacy.config.json.
func authOptions(secret string, bc config.LegacyConfig) (auth.Options, error) {
	dur, err := auth.ParseDuration(bc.JWTToken.Duration)
	if err != nil {
		return auth.Options{}, err
	}
	opts := auth.Options{Secret: []byte(secret), Duration: dur, Strategies: map[string]auth.StrategyOptions{}}
	for id, st := range bc.AuthStrategies {
		so := auth.StrategyOptions{MaxLoginAttempt: st.Options.MaxLoginAttempt}
		if st.Options.LockoutDuration != "" {
			if d, err := auth.ParseDuration(st.Options.LockoutDuration); err == nil {
				so.LockoutDuration = d
			}
		}
		opts.Strategies[id] = so
	}
	for _, a := range bc.SuperAdmins {
		opts.SuperAdmins = append(opts.SuperAdmins, auth.Account{Email: a.Email, Strategy: a.Strategy})
	}
	return opts, nil
}

func serve(cfg config.Config, logger *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	db, err := openDB(cfg)
	if err != nil {
		return err
	}
	store, err := openStore(cfg, db)
	if err != nil {
		return err
	}

	bc, err := readGlobalConfig(ctx, store, cfg.GlobalConfigFile)
	if err != nil {
		return err
	}
	secret, err := config.ResolveAppSecret(cfg.AppSecret, bc)
	if err != nil {
		return err
	}
	authOpts, err := authOptions(secret, bc)
	if err != nil {
		return err
	}
	authSvc, err := auth.New(&auth.PGUserStore{DB: db}, authOpts)
	if err != nil {
		return err
	}

	var locker lock.Locker = lock.NewMemory()
	if cfg.RedisURL != "" {
		ropts, err := redis.ParseURL(cfg.RedisURL)
		if err != nil {
			return fmt.Errorf("REDIS_URL: %w", err)
		}
		locker = lock.NewRedis(redis.NewClient(ropts))
		logger.Info("distributed locks enabled (redis)")
	} else {
		logger.Warn("REDIS_URL not set: locks are in-process; run a single replica only")
	}

	sessions := state.NewPostgresSessions(db)
	kvs := state.NewPostgresKVS(db)
	eng := engine.New(engine.Deps{
		Store:    store,
		DB:       db,
		Locker:   locker,
		State:    &state.Manager{Sessions: sessions, Users: state.NewPostgresUsers(db), KVS: kvs},
		Sessions: sessions,
		KVS:      kvs,
		Logger:   logger,
		UserCode: usercode.New(usercode.Options{
			Console: os.Stderr,
			Timeout: cfg.UserCodeTimeout,
		}),
		Global: globalDialog(cfg, bc),
	})

	janitorCtx, stopJanitor := context.WithCancel(ctx)
	defer stopJanitor()
	go eng.RunJanitor(janitorCtx)

	external := cfg.ExternalURL
	if external == "" {
		external = fmt.Sprintf("http://localhost:%d", cfg.Port)
	}
	studioSvc := studioapi.New(store)
	studioSvc.SetMediaLimits(mediaLimits(bc))
	handler := api.NewRouter(api.Deps{
		Engine:         eng,
		Auth:           authSvc,
		Studio:         studioSvc,
		ExternalPrefix: strings.TrimRight(external, "/"),
		Web:            web.Handler(),
		Logger:         logger,
	})

	srv := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.Port),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		logger.Info("listening", "port", cfg.Port)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		logger.Info("shutting down")
		shutCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		stopJanitor()
		if err := srv.Shutdown(shutCtx); err != nil {
			return err
		}
	}
	return nil
}

// validateCmd runs flow.Load + flow.Validate on the selected bots. It exits non-zero when any issue is found.
func validateCmd(cfg config.Config, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("validate", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	botID := fs.String("bot", "", "bot id to validate")
	all := fs.Bool("all", false, "validate every bot in the database")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *botID != "" && *all {
		return errors.New("use either --bot or --all")
	}
	if *botID == "" && !*all {
		*all = true
	}

	ctx := context.Background()
	var db *gorm.DB
	if cfg.BotFSDir == "" {
		var err error
		if db, err = openDB(cfg); err != nil {
			return err
		}
	}
	store, err := openStore(cfg, db)
	if err != nil {
		return err
	}

	ids := []string{*botID}
	if *all {
		if ids, err = listBotIDs(ctx, store); err != nil {
			return err
		}
	}
	if len(ids) == 0 {
		fmt.Fprintln(stdout, "no bots found")
		return nil
	}

	failed := 0
	for _, id := range ids {
		issues, err := validateBot(ctx, store, id)
		if err != nil {
			failed++
			fmt.Fprintf(stdout, "%s: load error: %v\n", id, err)
			continue
		}
		if len(issues) == 0 {
			fmt.Fprintf(stdout, "%s: ok\n", id)
			continue
		}
		failed++
		for _, is := range issues {
			fmt.Fprintf(stdout, "%s: %s: %s\n", id, is.File, is.Message)
		}
	}
	fmt.Fprintf(stdout, "%d of %d bots with issues\n", failed, len(ids))
	if failed > 0 {
		return fmt.Errorf("%d bot(s) failed validation", failed)
	}
	return nil
}

func validateBot(ctx context.Context, store botfs.Store, id string) ([]flow.Issue, error) {
	bot, err := flow.Load(ctx, store, id)
	if err != nil {
		return nil, err
	}
	return flow.Validate(bot), nil
}

// listBotIDs returns the ids of every bot folder that has a bot.config.json.
func listBotIDs(ctx context.Context, store botfs.Store) ([]string, error) {
	files, err := store.ListFiles(ctx, "data/bots/")
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, f := range files {
		rest := strings.TrimPrefix(f.Path, "data/bots/")
		if strings.HasSuffix(rest, "/bot.config.json") {
			id := strings.TrimSuffix(rest, "/bot.config.json")
			if !strings.Contains(id, "/") {
				ids = append(ids, id)
			}
		}
	}
	sort.Strings(ids)
	return ids, nil
}

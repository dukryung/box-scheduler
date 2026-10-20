package main

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"box-scheduler/server/internal/ai"
	"box-scheduler/server/internal/auth"
	"box-scheduler/server/internal/httpapi"
	"box-scheduler/server/internal/store"
	"box-scheduler/server/migrations"
)

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	addr := ":" + envOr("PORT", "8080")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	if err := migrate(pool); err != nil {
		return err
	}

	planner, provider, err := ai.NewFromEnv()
	if err != nil {
		return err
	}
	slog.Info("ai planner", "provider", provider)

	st := store.New(pool)
	publicURL := strings.TrimRight(envOr("PUBLIC_URL", "http://localhost:3080"), "/")
	opts := httpapi.Options{
		CookieSecure: os.Getenv("COOKIE_SECURE") == "true",
		LoginPerIP:   atoiOr(os.Getenv("LOGIN_LIMIT_PER_IP")),
		SignupPerIP:  atoiOr(os.Getenv("SIGNUP_LIMIT_PER_IP")),
		Google: &auth.Google{
			ClientID:     os.Getenv("GOOGLE_CLIENT_ID"),
			ClientSecret: os.Getenv("GOOGLE_CLIENT_SECRET"),
			RedirectURL:  publicURL + "/api/auth/google/callback",
			AuthURL:      envOr("GOOGLE_AUTH_URL", "https://accounts.google.com/o/oauth2/v2/auth"),
			TokenURL:     envOr("GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token"),
		},
	}
	slog.Info("google sign-in", "enabled", opts.Google.Enabled(), "redirect", opts.Google.RedirectURL)
	needsSetup, err := st.OwnerNeedsSetup(ctx)
	if err != nil {
		return err
	}
	if needsSetup {
		// The owner account holds the data from before accounts existed. Whoever can
		// read this log claims it once; SETUP_TOKEN pins the token (test stacks).
		opts.SetupToken = os.Getenv("SETUP_TOKEN")
		if opts.SetupToken == "" {
			if opts.SetupToken, _, err = auth.NewToken(); err != nil {
				return err
			}
		}
		slog.Warn("owner account not set up yet: open this link once to claim it",
			"url", publicURL+"/setup?token="+opts.SetupToken)
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           httpapi.NewRouter(st, planner, opts),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("listening", "addr", addr)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

func migrate(pool *pgxpool.Pool) error {
	db := stdlib.OpenDBFromPool(pool)
	defer func(db *sql.DB) { _ = db.Close() }(db)

	goose.SetBaseFS(migrations.FS)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	return goose.Up(db, ".")
}

func atoiOr(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

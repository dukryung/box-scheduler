// Command migrate brings the database up to date and sets up the two login
// roles: app_service for the app server and app_admin for the admin server.
// It runs once before either server starts, as the database owner.
package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"box-scheduler/server/migrations"
)

func main() {
	if err := run(context.Background()); err != nil {
		slog.Error("migrate", "err", err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	db := stdlib.OpenDBFromPool(pool)
	defer func(db *sql.DB) { _ = db.Close() }(db)
	goose.SetBaseFS(migrations.FS)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	if err := goose.Up(db, "."); err != nil {
		return err
	}

	for _, r := range []struct{ name, env string }{{"app_service", "SERVICE_DB_PASSWORD"}, {"app_admin", "ADMIN_DB_PASSWORD"}} {
		pw := os.Getenv(r.env)
		if pw == "" {
			return fmt.Errorf("%s is required", r.env)
		}
		if _, err := pool.Exec(ctx, fmt.Sprintf(`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '%[1]s') THEN CREATE ROLE %[1]s LOGIN; END IF;
		END $$`, r.name)); err != nil {
			return err
		}
		if _, err := pool.Exec(ctx, fmt.Sprintf(`ALTER ROLE %s LOGIN PASSWORD '%s'`, r.name, strings.ReplaceAll(pw, "'", "''"))); err != nil {
			return err
		}
	}
	if _, err := pool.Exec(ctx, grants); err != nil {
		return fmt.Errorf("grants: %w", err)
	}
	slog.Info("database ready", "roles", "app_service, app_admin")
	return nil
}

// grants is re-applied on every run, so tables added by later migrations are covered.
const grants = `
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_service, app_admin', current_database()); END $$;

-- The app server: everything in public, nothing in admin.
GRANT USAGE ON SCHEMA public TO app_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_service;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_service;
-- The service AI is set by admins; the app server only reads it.
REVOKE INSERT, UPDATE, DELETE ON public.service_ai FROM app_service;
REVOKE ALL ON SCHEMA admin FROM PUBLIC, app_service;

-- The admin server: its own schema, plus the account facts and counts it manages.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_admin;
GRANT USAGE ON SCHEMA admin, public TO app_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA admin TO app_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA admin TO app_admin;
GRANT SELECT (id, email, status, is_owner) ON public.users TO app_admin;
GRANT UPDATE (status) ON public.users TO app_admin;
GRANT DELETE ON public.users TO app_admin;
GRANT SELECT, DELETE ON public.sessions TO app_admin;
GRANT INSERT ON public.password_resets TO app_admin;
GRANT SELECT ON public.user_activity, public.ai_usage, public.ai_calls TO app_admin;
GRANT SELECT, UPDATE ON public.service_ai TO app_admin;
`

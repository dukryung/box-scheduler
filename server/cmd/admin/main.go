// Command admin runs the admin console's API server, and manages admin
// accounts from the command line (there is no sign-up for admins):
//
//	admin                      serve the admin API (default)
//	admin create --email E --name N --role super|operator [--password-stdin]
//	admin list
//	admin reset --email E [--password-stdin]   new temporary password, 2FA cleared, unlocked
//	admin disable --email E / admin enable --email E
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"box-scheduler/server/internal/adminapi"
	"box-scheduler/server/internal/adminstore"
	"box-scheduler/server/internal/auth"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	cmd := "serve"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return err
	}
	// A small pool of its own, so the console can never crowd out the app's connections.
	cfg.MaxConns = int32(atoiOr(os.Getenv("ADMIN_DB_MAX_CONNS"), 5))
	cfg.ConnConfig.RuntimeParams["statement_timeout"] = "10000"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return err
	}
	defer pool.Close()
	st := adminstore.New(pool)

	switch cmd {
	case "serve":
		return serve(ctx, st)
	case "create":
		fs := flag.NewFlagSet("create", flag.ContinueOnError)
		email := fs.String("email", "", "admin email (sign-in id)")
		name := fs.String("name", "", "display name")
		role := fs.String("role", "operator", "super or operator")
		stdin := fs.Bool("password-stdin", false, "read the first password from stdin instead of generating one")
		if err := fs.Parse(args); err != nil {
			return err
		}
		if *email == "" || (*role != "super" && *role != "operator") {
			return errors.New("usage: admin create --email E --name N --role super|operator")
		}
		pw, shown, err := firstPassword(*stdin)
		if err != nil {
			return err
		}
		hash, err := auth.HashPassword(pw)
		if err != nil {
			return err
		}
		acc, err := st.CreateAccount(ctx, *email, *name, *role, hash)
		if err != nil {
			return err
		}
		_ = st.Audit(ctx, "cli", "admin-create", acc.ID, acc.Email, acc.Role, "")
		fmt.Printf("created %s admin %s\n", acc.Role, acc.Email)
		if shown {
			fmt.Printf("temporary password (shown once; it must be changed at first sign-in): %s\n", pw)
		}
		return nil
	case "list":
		list, err := st.ListAccounts(ctx)
		if err != nil {
			return err
		}
		for _, a := range list {
			fmt.Printf("%-32s %-8s %-8s 2fa=%-5v must-change=%v\n", a.Email, a.Role, a.Status, a.TOTPEnabled, a.MustChangePassword)
		}
		return nil
	case "reset", "disable", "enable":
		fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
		email := fs.String("email", "", "admin email")
		stdin := fs.Bool("password-stdin", false, "read the new password from stdin")
		if err := fs.Parse(args); err != nil {
			return err
		}
		acc, err := st.AccountByEmail(ctx, *email)
		if err != nil {
			return fmt.Errorf("%s: %w", *email, err)
		}
		if cmd != "reset" {
			status := map[string]string{"disable": "disabled", "enable": "active"}[cmd]
			if _, err := st.SetAccount(ctx, acc.ID, nil, &status); err != nil {
				return err
			}
			_ = st.Audit(ctx, "cli", "admin-"+cmd, acc.ID, acc.Email, "", "")
			fmt.Printf("%s: %s\n", acc.Email, status)
			return nil
		}
		pw, shown, err := firstPassword(*stdin)
		if err != nil {
			return err
		}
		hash, err := auth.HashPassword(pw)
		if err == nil {
			err = st.ResetAccess(ctx, acc.ID, hash)
		}
		if err != nil {
			return err
		}
		_ = st.Audit(ctx, "cli", "admin-reset", acc.ID, acc.Email, "", "")
		fmt.Printf("%s: password reset, two-factor cleared, signed out\n", acc.Email)
		if shown {
			fmt.Printf("temporary password (shown once): %s\n", pw)
		}
		return nil
	}
	return fmt.Errorf("unknown command %q (serve, create, list, reset, disable, enable)", cmd)
}

// firstPassword reads one line from stdin, or generates a temporary password to print.
func firstPassword(fromStdin bool) (pw string, shown bool, err error) {
	if !fromStdin {
		return adminapi.TempPassword(), true, nil
	}
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && line == "" {
		return "", false, errors.New("no password on stdin")
	}
	pw = strings.TrimRight(line, "\r\n")
	if len([]rune(pw)) < 12 {
		return "", false, errors.New("admin passwords need at least 12 characters")
	}
	return pw, false, nil
}

func serve(ctx context.Context, st *adminstore.Store) error {
	addr := ":" + envOr("PORT", "8090")
	srv := &http.Server{
		Addr: addr,
		Handler: adminapi.NewRouter(st, adminapi.Options{
			CookieSecure: os.Getenv("COOKIE_SECURE") == "true",
			ServiceURL:   envOr("SERVICE_PUBLIC_URL", "http://localhost:3080"),
			LoginPerIP:   atoiOr(os.Getenv("ADMIN_LOGIN_LIMIT_PER_IP"), 30),
		}),
		ReadHeaderTimeout: 10 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		slog.Info("admin api listening", "addr", addr)
		errCh <- srv.ListenAndServe()
	}()
	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdown)
}

func atoiOr(s string, d int) int {
	if n, err := strconv.Atoi(s); err == nil && n > 0 {
		return n
	}
	return d
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

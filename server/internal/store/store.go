// Package store holds all PostgreSQL access for the scheduler.
package store

import (
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const SlotsPerDay = 144

var (
	ErrNotFound = errors.New("not found")
	// ErrConflict means a time block would overlap an existing one.
	ErrConflict = errors.New("time block overlaps an existing block")
	ErrInvalid  = errors.New("invalid input")
)

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// mapErr turns driver errors into the store's sentinel errors.
func mapErr(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23P01": // exclusion_violation
			return ErrConflict
		case "23514", "23503", "22P02", "22007", "22008": // check, FK, bad text repr, bad date
			return ErrInvalid
		}
	}
	return err
}

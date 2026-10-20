-- +goose Up
-- Google sign-in: the stable Google account id ("sub") linked to an account.
ALTER TABLE users ADD COLUMN google_sub TEXT UNIQUE;

-- +goose Down
ALTER TABLE users DROP COLUMN google_sub;

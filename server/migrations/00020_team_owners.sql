-- +goose Up
-- A team may have more than one owner; the server keeps at least one.
DROP INDEX team_members_one_owner;

-- +goose Down
-- Fails while a team has two owners: hand the extra ones another role first.
CREATE UNIQUE INDEX team_members_one_owner ON team_members (team_id) WHERE role = 'owner';

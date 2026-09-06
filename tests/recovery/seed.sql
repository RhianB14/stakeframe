-- Fixtures only. No account or data from the running application is read.
CREATE ROLE stk_fixture_owner NOLOGIN;
CREATE ROLE stk_fixture_reader NOLOGIN;
CREATE ROLE stk_fixture_member NOLOGIN;
GRANT stk_fixture_reader TO stk_fixture_member;
CREATE SCHEMA recovery_probe AUTHORIZATION stk_fixture_owner;
REVOKE ALL ON SCHEMA recovery_probe FROM PUBLIC;
SET ROLE stk_fixture_owner;
GRANT USAGE ON SCHEMA recovery_probe TO stk_fixture_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA recovery_probe GRANT SELECT ON TABLES TO stk_fixture_reader;
CREATE TABLE recovery_probe.entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  amount numeric(18, 2) NOT NULL CHECK (amount <> 0),
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL
);
INSERT INTO recovery_probe.entries (amount, occurred_at, payload) VALUES
  (123.45, '2026-09-06 12:34:56.123456-03', '{"marker":"RECOVERY_FIXTURE_PRIVATE_PAYLOAD", "text":"Ação · São Paulo"}'),
  (-6.70, '2026-09-07 01:00:00+00', '{"flags":[true,false], "value":null}');
CREATE TABLE recovery_probe.references (entry_id bigint REFERENCES recovery_probe.entries(id));
INSERT INTO recovery_probe.references VALUES (1), (2);
CREATE VIEW recovery_probe.summary AS SELECT count(*) AS total, sum(amount) AS amount FROM recovery_probe.entries;
RESET ROLE;
INSERT INTO auth."user" (id, name, email, email_verified) VALUES ('fixture-owner', 'Recovery Fixture', 'recovery@example.test', true);
INSERT INTO auth.account (id, account_id, provider_id, user_id) VALUES ('fixture-account', 'fixture-subject', 'google', 'fixture-owner');
INSERT INTO auth.session (id, token, user_id, expires_at) VALUES ('fixture-session', 'RECOVERY_FIXTURE_PRIVATE_PAYLOAD_SESSION', 'fixture-owner', '2026-09-07 12:00:00+00');
INSERT INTO auth.verification (id, identifier, value, expires_at) VALUES ('fixture-verification', 'fixture-identifier', 'fixture-value', '2026-09-07 12:00:00+00');

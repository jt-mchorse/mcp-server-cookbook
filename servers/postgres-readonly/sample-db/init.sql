-- Sample schema for the postgres-readonly MCP server.
-- Loaded once on first boot of the docker compose database via the
-- /docker-entrypoint-initdb.d/ mount.
--
-- Two principles:
--   1. The schema is interesting enough that describe_schema produces non-trivial
--      output (FK, view, enum). A boring schema makes the tool look broken.
--   2. The seed creates a SEPARATE read-only role that the MCP server uses, so
--      D-004's "DB-side enforcement" is exercised end-to-end on the sample DB
--      without manual setup.

CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');

CREATE TABLE customers (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  full_name   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE orders (
  id          SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status      order_status NOT NULL DEFAULT 'pending',
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE VIEW recent_paid_orders AS
  SELECT o.id, o.customer_id, c.email, o.total_cents, o.created_at
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
   WHERE o.status = 'paid'
     AND o.created_at >= NOW() - INTERVAL '30 days';

INSERT INTO customers (email, full_name) VALUES
  ('alex@example.com', 'Alex Example'),
  ('blair@example.com', 'Blair Example'),
  ('chen@example.com', 'Chen Example');

INSERT INTO orders (customer_id, status, total_cents) VALUES
  (1, 'paid',     12500),
  (1, 'pending',  4200),
  (2, 'shipped',  9900),
  (2, 'paid',     3300),
  (3, 'cancelled', 1500);

-- Read-only role used by the MCP server on the sample DB.
-- DB-side enforcement (D-004 first layer): role grants are SELECT only.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_reader') THEN
    CREATE ROLE mcp_reader WITH LOGIN PASSWORD 'mcp_reader';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE bench TO mcp_reader;
GRANT USAGE ON SCHEMA public TO mcp_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_reader;

-- Explicitly REVOKE write privileges so even an accidental future GRANT ALL
-- can be diagnosed by reading this file.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM mcp_reader;

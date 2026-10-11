-- VG Codeworks database (Cloudflare D1). Paste into the D1 console once.
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  area TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reg TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id),
  model TEXT,
  year TEXT,
  engine TEXT,
  vin TEXT,
  notes TEXT,            -- coding log
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS cars_reg ON cars(reg);

-- status: enquiry | booked | done | cancelled ; paid: 0/1
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id),
  car_id INTEGER REFERENCES cars(id),
  kind TEXT DEFAULT 'quote',       -- quote | fault | part | source | booking
  service TEXT,
  status TEXT NOT NULL DEFAULT 'enquiry',
  starts_at TEXT,                  -- local time 'YYYY-MM-DDTHH:MM' (Europe/London)
  duration_min INTEGER,
  price REAL,
  paid INTEGER NOT NULL DEFAULT 0,  -- 1 once the full price is paid
  deposit REAL DEFAULT 0,          -- deposit already taken
  paid_at TEXT,
  method TEXT,
  code TEXT,
  details TEXT,                    -- what the customer sent
  notes TEXT,                      -- your notes
  source TEXT,                     -- website | stripe | telegram | desk
  stripe_session TEXT UNIQUE,
  gcal_event_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_starts ON jobs(starts_at);

-- ============================================================
-- GESTAWAY — Migrazione Supabase per integrazione Channex
-- Esegui questo script nel SQL Editor di Supabase
-- (Dashboard → SQL Editor → New query → Esegui)
-- ============================================================

-- ── 1. Mapping strutture ────────────────────────────────────
-- Collega ogni struttura Gestaway al corrispondente Property UUID su Channex
CREATE TABLE IF NOT EXISTS channex_mappings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gestaway_property_id  UUID NOT NULL,         -- ID interno (es. UUID della struttura B&B)
  gestaway_nome         TEXT NOT NULL,         -- nome leggibile per debug
  channex_property_id   UUID NOT NULL UNIQUE,  -- UUID assegnato da Channex
  channex_api_key       TEXT,                  -- opzionale: API key per-property (se diversa da quella globale)
  ultimo_full_sync      TIMESTAMPTZ,
  attivo                BOOLEAN DEFAULT true,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ── 2. Mapping camere / room types ──────────────────────────
CREATE TABLE IF NOT EXISTS channex_room_mappings (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gestaway_property_id    UUID NOT NULL REFERENCES channex_mappings(gestaway_property_id) ON DELETE CASCADE,
  gestaway_room_id        TEXT NOT NULL,           -- ID camera nel sistema Gestaway (es. UUID Supabase)
  gestaway_room_nome      TEXT NOT NULL,           -- nome leggibile
  channex_room_type_id    UUID NOT NULL UNIQUE,    -- UUID room type su Channex
  channex_room_type_nome  TEXT,
  disponibilita_default   INTEGER DEFAULT 1,       -- disponibilità base da usare nel full sync
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3. Mapping tariffe / rate plans ─────────────────────────
CREATE TABLE IF NOT EXISTS channex_rate_mappings (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gestaway_property_id    UUID NOT NULL REFERENCES channex_mappings(gestaway_property_id) ON DELETE CASCADE,
  gestaway_room_id        TEXT,                    -- camera di appartenenza (opzionale per lookup)
  channex_room_type_id    UUID,                    -- room type Channex di riferimento
  channex_rate_plan_id    UUID NOT NULL UNIQUE,    -- UUID rate plan su Channex
  channex_rate_plan_nome  TEXT,
  prezzo_default          NUMERIC(10,2) DEFAULT 100.00,
  min_stay_default        INTEGER DEFAULT 1,
  valuta                  CHAR(3) DEFAULT 'EUR',
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

-- ── 4. Outbox — coda persistente chiamate ARI ───────────────
-- I job vengono processati dal worker con rate limiting (20/min)
CREATE TABLE IF NOT EXISTS channex_outbox (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo          TEXT NOT NULL CHECK (tipo IN ('availability','restrictions')),
  payload       JSONB NOT NULL,               -- { values: [...] }
  property_id   UUID,                         -- gestaway_property_id di riferimento
  stato         TEXT NOT NULL DEFAULT 'pending'
                  CHECK (stato IN ('pending','done','failed')),
  tentativi     INTEGER DEFAULT 0,
  task_ids      TEXT[],                       -- task ID restituiti da Channex
  errore        TEXT,
  elaborato_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Indice per velocizzare il polling della coda
CREATE INDEX IF NOT EXISTS idx_channex_outbox_stato
  ON channex_outbox (stato, created_at)
  WHERE stato = 'pending';

-- ── 5. Prenotazioni ricevute da Channex ──────────────────────
CREATE TABLE IF NOT EXISTS channex_prenotazioni (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channex_booking_id    TEXT NOT NULL UNIQUE,     -- ID prenotazione Channex
  channex_revision_id   TEXT,                     -- ID ultima revision
  channex_property_id   UUID,                     -- property Channex
  gestaway_property_id  UUID,                     -- struttura Gestaway corrispondente
  stato                 TEXT DEFAULT 'new'
                          CHECK (stato IN ('new','modified','cancelled')),
  ota_name              TEXT,                     -- es. 'Booking.com', 'Airbnb'
  ota_reservation_code  TEXT,
  arrivo                DATE,
  partenza              DATE,
  importo               NUMERIC(10,2),
  valuta                CHAR(3),
  ospite_nome           TEXT,
  ospite_cognome        TEXT,
  ospite_email          TEXT,
  ospite_telefono       TEXT,
  adulti                INTEGER,
  bambini               INTEGER DEFAULT 0,
  note                  TEXT,
  raw_payload           JSONB,                    -- payload completo da Channex per debug
  acknowledged_at       TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channex_pren_property
  ON channex_prenotazioni (gestaway_property_id);
CREATE INDEX IF NOT EXISTS idx_channex_pren_arrivo
  ON channex_prenotazioni (arrivo);
CREATE INDEX IF NOT EXISTS idx_channex_pren_stato
  ON channex_prenotazioni (stato);

-- ── 6. Log chiamate Channex (audit trail) ───────────────────
CREATE TABLE IF NOT EXISTS channex_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo          TEXT,             -- 'ari_push', 'booking_ack', 'full_sync', 'webhook'
  property_id   UUID,
  dettagli      JSONB,
  esito         TEXT,             -- 'ok' | 'errore'
  messaggio     TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Row Level Security ───────────────────────────────────────
-- Abilita RLS su tutte le tabelle (solo il service role può scrivere)
ALTER TABLE channex_mappings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE channex_room_mappings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE channex_rate_mappings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE channex_outbox           ENABLE ROW LEVEL SECURITY;
ALTER TABLE channex_prenotazioni     ENABLE ROW LEVEL SECURITY;
ALTER TABLE channex_log              ENABLE ROW LEVEL SECURITY;

-- Il server usa la service key → può fare tutto senza policy aggiuntive
-- (anon key non ha accesso a queste tabelle)

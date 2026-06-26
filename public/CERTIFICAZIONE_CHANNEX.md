# Guida alla Certificazione Channex — Gestaway

## Prima di tutto: configura l'ambiente

### 1. Variabili d'ambiente
Copia `.env.example` in `.env` e compila:
```
CHANNEX_API_KEY=la-tua-chiave-staging
CHANNEX_ENV=staging
BASE_URL=https://tuo-server-pubblico.com
```

### 2. Esegui la migrazione SQL su Supabase
Nel SQL Editor di Supabase, esegui il contenuto di `channex_migration.sql`.
Crea le tabelle: `channex_mappings`, `channex_room_mappings`, `channex_rate_mappings`,
`channex_outbox`, `channex_prenotazioni`, `channex_log`.

### 3. Installa le dipendenze
```bash
npm install
```

---

## Fase 1 — Setup mapping su Channex (staging)

### 1a. Crea la property di test su Channex
Vai su https://staging.channex.io → Properties → Create Property, oppure via API:

```bash
curl -X POST https://staging.channex.io/api/v1/properties \
  -H "x-api-key: TUA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "property": {
      "title": "Test Property - Gestaway",
      "currency": "USD",
      "timezone": "Europe/Rome",
      "email": "test@gestaway.com",
      "country": "IT"
    }
  }'
```
Salva il `channex_property_id` dalla risposta.

### 1b. Crea 2 Room Types
```bash
# Twin Room
curl -X POST https://staging.channex.io/api/v1/room_types \
  -H "x-api-key: TUA_API_KEY" -H "Content-Type: application/json" \
  -d '{"room_type": {"property_id": "CHANNEX_PROPERTY_ID", "title": "Twin Room", "count_of_rooms": 5, "max_persons": 2}}'

# Double Room
curl -X POST https://staging.channex.io/api/v1/room_types \
  -H "x-api-key: TUA_API_KEY" -H "Content-Type: application/json" \
  -d '{"room_type": {"property_id": "CHANNEX_PROPERTY_ID", "title": "Double Room", "count_of_rooms": 5, "max_persons": 2}}'
```

### 1c. Crea 4 Rate Plans
```bash
# Twin - Best Available Rate (BAR)
# Twin - Bed & Breakfast
# Double - Best Available Rate (BAR)
# Double - Bed & Breakfast
# Usa il JSON: {"rate_plan": {"property_id": "...", "room_type_id": "...", "title": "...", "currency": "USD", "rate_mode": "manual", "default_occupancy": 2}}
```

### 1d. Salva i mapping in Gestaway
Usa questi endpoint (autenticato):

```bash
# Mapping property
POST /api/channex/mappings
{ "gestaway_property_id": "UUID-struttura-gestaway", "gestaway_nome": "Il Tuo B&B", "channex_property_id": "UUID-da-channex" }

# Mapping camera
POST /api/channex/room-mappings
{ "gestaway_property_id": "...", "gestaway_room_id": "ID-camera", "gestaway_room_nome": "Twin Room", "channex_room_type_id": "UUID-da-channex", "disponibilita_default": 5 }

# Mapping tariffa
POST /api/channex/rate-mappings
{ "gestaway_property_id": "...", "channex_rate_plan_id": "UUID-da-channex", "channex_rate_plan_nome": "Best Available Rate", "prezzo_default": 100, "min_stay_default": 1, "valuta": "USD" }
```

---

## Fase 2 — Esegui i 14 test di certificazione

### Test 1 — Full Sync (500 giorni)
```bash
POST /api/channex/full-sync/TUO_GESTAWAY_PROPERTY_ID
```
Controlla la risposta: salva i task ID dall'outbox.
```bash
GET /api/channex/outbox
```

### Test 2 — Single Date Update (singola tariffa)
Nell'interfaccia Gestaway, modifica il prezzo di una camera per il 22/11/2026.
L'integrazione emette automaticamente il delta push.
Oppure triggera direttamente:
```bash
POST /api/channex/push-ari/TUO_PROPERTY_ID
{
  "tipo": "restrictions",
  "values": [{
    "property_id": "CHANNEX_PROPERTY_ID",
    "rate_plan_id": "UUID_TWIN_BAR",
    "date": "2026-11-22",
    "rate": 33300
  }]
}
```

### Test 3 — Multiple Rates, Single Dates
```bash
POST /api/channex/push-ari/TUO_PROPERTY_ID
{
  "tipo": "restrictions",
  "values": [
    {"property_id": "...", "rate_plan_id": "UUID_TWIN_BAR",    "date": "2026-11-21", "rate": 33300},
    {"property_id": "...", "rate_plan_id": "UUID_DOUBLE_BAR",  "date": "2026-11-25", "rate": 44400},
    {"property_id": "...", "rate_plan_id": "UUID_DOUBLE_BB",   "date": "2026-11-29", "rate": 45623}
  ]
}
```
⚠️ Tutti e 3 nello stesso array = 1 sola chiamata API ✓

### Test 4 — Date Range, Multiple Rates
```bash
{
  "tipo": "restrictions",
  "values": [
    {"property_id": "...", "rate_plan_id": "UUID_TWIN_BAR",   "date_from": "2026-11-01", "date_to": "2026-11-10", "rate": 24100},
    {"property_id": "...", "rate_plan_id": "UUID_DOUBLE_BAR", "date_from": "2026-11-10", "date_to": "2026-11-16", "rate": 31266},
    {"property_id": "...", "rate_plan_id": "UUID_DOUBLE_BB",  "date_from": "2026-11-01", "date_to": "2026-11-20", "rate": 11100}
  ]
}
```

### Test 5 — Min Stay
```bash
{
  "tipo": "restrictions",
  "values": [
    {"property_id": "...", "rate_plan_id": "UUID_TWIN_BAR",  "date": "2026-11-23", "min_stay": 3},
    {"property_id": "...", "rate_plan_id": "UUID_DOUBLE_BAR","date": "2026-11-25", "min_stay": 2},
    {"property_id": "...", "rate_plan_id": "UUID_DOUBLE_BB", "date": "2026-11-15", "min_stay": 5}
  ]
}
```

### Test 6 — Stop Sell
```bash
{
  "tipo": "restrictions",
  "values": [
    {"property_id": "...", "rate_plan_id": "UUID_TWIN_BAR",  "date": "2026-11-14", "stop_sell": true},
    {"property_id": "...", "rate_plan_id": "UUID_DOUBLE_BAR","date": "2026-11-16", "stop_sell": true},
    {"property_id": "...", "rate_plan_id": "UUID_DOUBLE_BB", "date": "2026-11-20", "stop_sell": true}
  ]
}
```

### Test 7 — Multiple Restrictions
```bash
{
  "tipo": "restrictions",
  "values": [
    {"property_id": "...", "rate_plan_id": "UUID_TWIN_BAR",  "date_from": "2026-11-01", "date_to": "2026-11-10", "closed_to_arrival": true,  "closed_to_departure": false, "max_stay": 4, "min_stay": 1},
    {"property_id": "...", "rate_plan_id": "UUID_TWIN_BB",   "date_from": "2026-11-12", "date_to": "2026-11-16", "closed_to_arrival": false, "closed_to_departure": true,  "min_stay": 6},
    {"property_id": "...", "rate_plan_id": "UUID_DOUBLE_BAR","date_from": "2026-11-10", "date_to": "2026-11-16", "closed_to_arrival": true,  "min_stay": 2},
    {"property_id": "...", "rate_plan_id": "UUID_DOUBLE_BB", "date_from": "2026-11-01", "date_to": "2026-11-20", "min_stay": 10}
  ]
}
```

### Test 8 — Half-Year Update
```bash
{
  "tipo": "restrictions",
  "values": [
    {"property_id": "...", "rate_plan_id": "UUID_TWIN_BAR",  "date_from": "2026-12-01", "date_to": "2027-05-01", "rate": 43200, "closed_to_arrival": false, "closed_to_departure": false, "min_stay": 2},
    {"property_id": "...", "rate_plan_id": "UUID_DOUBLE_BAR","date_from": "2026-12-01", "date_to": "2027-05-01", "rate": 34200, "min_stay": 3}
  ]
}
```

### Test 9 — Single Date Availability
```bash
POST /api/channex/push-ari/TUO_PROPERTY_ID
{
  "tipo": "availability",
  "values": [
    {"property_id": "...", "room_type_id": "UUID_TWIN",   "date": "2026-11-21", "availability": 7},
    {"property_id": "...", "room_type_id": "UUID_DOUBLE", "date": "2026-11-25", "availability": 0}
  ]
}
```

### Test 10 — Multiple Date Availability
```bash
{
  "tipo": "availability",
  "values": [
    {"property_id": "...", "room_type_id": "UUID_TWIN",   "date_from": "2026-11-10", "date_to": "2026-11-16", "availability": 3},
    {"property_id": "...", "room_type_id": "UUID_DOUBLE", "date_from": "2026-11-17", "date_to": "2026-11-24", "availability": 4}
  ]
}
```

### Test 11 — Prenotazioni (Booking Receiving)
1. Registra il webhook su Channex:
```bash
POST /api/channex/setup-webhook
```
2. Collega il canale Booking.com test (property 5868189 su staging)
3. Crea una prenotazione su https://secure.booking.com/book.html?hotel_id=5868189&test=1
4. Verifica che arrivi nel gestionale:
```bash
GET /api/channex/prenotazioni
```
5. Oppure triggera il polling manuale:
```bash
POST /api/channex/poll-bookings
```

### Test 12 — Rate Limits
L'outbox rispetta automaticamente il limite di 20 ARI/minuto.
Risposta al form: "Sì, utilizziamo una coda persistente con rate limiting a 18 req/min (margine di sicurezza). In caso di 429, implementiamo exponential backoff (2s → 4s → 8s)."

### Test 13 — Update Logic
Risposta al form: "Sì, inviamo solo delta update al cambio di disponibilità/prezzi nel PMS. Il full sync avviene solo al setup iniziale o su richiesta esplicita, mai su timer."

### Test 14 — Extra Notes
- Min Stay: supportiamo `min_stay` (tipo virtuale, mappato su `min_stay_arrival` dalla property)
- Restrizioni non supportate: nessuna — supportiamo stop_sell, CTA, CTD, min_stay, max_stay
- Multiple room types e rate plans: sì, supportati tramite mapping layer
- Carte di credito: no — non siamo PCI certified, non riceviamo dati carta
- Multiple rate plans: sì

---

## Fase 3 — Raccogli i Task ID

Per ogni test, recupera i task ID:
```bash
GET /api/channex/outbox
```
Ogni job `done` ha il campo `task_ids` con gli UUID da inserire nel form Channex.

---

## Fase 4 — Invia il form di certificazione
https://forms.gle/xA8F3eSYBPBd8apYA

---

## Fase 5 — Live screenshare con Channex

Durante la call, Channex chiederà di:
1. Aprire Gestaway nel browser
2. Modificare un prezzo manualmente
3. Verificare che la chiamata parta dal codice reale (non da script)

Il codice in `channex.js` → `ChannexOutbox.flush()` è integrato nel path reale
del PMS, non in un harness di test. ✓

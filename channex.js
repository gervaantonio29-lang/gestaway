// ============================================================
// GESTAWAY — channex.js
// Modulo di integrazione con Channex.io (Channel Manager)
//
// Architettura:
//   1. ChannexClient     — wrapper HTTP per le API Channex
//   2. ChannexOutbox     — coda persistente su Supabase con
//                          rate limiting (20 ARI/min) e retry
//                          con exponential backoff
//   3. ChannexSync       — logica ARI: full sync + delta push
//   4. ChannexBookings   — polling Booking Revision Feed +
//                          Acknowledge obbligatorio
//   5. Route handlers    — da montare in server.js
// ============================================================

const CHANNEX_BASE = process.env.CHANNEX_ENV === 'production'
  ? 'https://api.channex.io/api/v1'
  : 'https://staging.channex.io/api/v1';

const CHANNEX_API_KEY = process.env.CHANNEX_API_KEY;

// Limite ufficiale: 10 restrizioni/min + 10 disponibilità/min per property
// Usiamo 18/min totali come soglia sicura con margine
const RATE_LIMIT_PER_MINUTE = 18;
const BOOKING_POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minuti

// ────────────────────────────────────────────────────────────
// 1. ChannexClient — wrapper HTTP
// ────────────────────────────────────────────────────────────
class ChannexClient {
  constructor(apiKey = CHANNEX_API_KEY, baseUrl = CHANNEX_BASE) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async _request(method, path, body = null, retries = 3) {
    const url = `${this.baseUrl}${path}`;
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
    };
    if (body) options.body = JSON.stringify(body);

    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetch(url, options);

      // Rate limit → exponential backoff
      if (res.status === 429) {
        if (attempt === retries) throw new Error('Channex rate limit: troppi tentativi');
        const waitMs = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
        console.warn(`[Channex] 429 Too Many Requests — attendo ${waitMs}ms (tentativo ${attempt + 1})`);
        await sleep(waitMs);
        continue;
      }

      // Errori server → retry
      if (res.status >= 500) {
        if (attempt === retries) throw new Error(`Channex server error ${res.status}`);
        const waitMs = Math.pow(2, attempt) * 1000;
        console.warn(`[Channex] ${res.status} — retry tra ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      const data = await res.json();

      if (res.status === 401) throw new Error('Channex: API key non valida o non autorizzata');
      if (!res.ok) throw new Error(`Channex error ${res.status}: ${JSON.stringify(data)}`);

      return data;
    }
  }

  get(path)         { return this._request('GET', path); }
  post(path, body)  { return this._request('POST', path, body); }
  put(path, body)   { return this._request('PUT', path, body); }
  delete(path)      { return this._request('DELETE', path); }

  // ── Properties ────────────────────────────────────────────
  async listProperties() {
    return this.get('/properties?pagination=false');
  }
  async createProperty(attrs) {
    return this.post('/properties', { property: attrs });
  }

  // ── Room Types ────────────────────────────────────────────
  async listRoomTypes(propertyId) {
    return this.get(`/room_types?property_id=${propertyId}&pagination=false`);
  }
  async createRoomType(attrs) {
    return this.post('/room_types', { room_type: attrs });
  }

  // ── Rate Plans ────────────────────────────────────────────
  async listRatePlans(propertyId) {
    return this.get(`/rate_plans?property_id=${propertyId}&pagination=false`);
  }
  async createRatePlan(attrs) {
    return this.post('/rate_plans', { rate_plan: attrs });
  }

  // ── ARI — Restrizioni & Prezzi ────────────────────────────
  async pushRestrictions(values) {
    // values: array di oggetti { property_id, rate_plan_id, date|date_from+date_to, rate?, min_stay?, ... }
    return this.post('/restrictions', { values });
  }

  // ── ARI — Disponibilità ───────────────────────────────────
  async pushAvailability(values) {
    // values: array di oggetti { property_id, room_type_id, date|date_from+date_to, availability }
    return this.post('/availability', { values });
  }

  // ── Booking Revisions Feed ────────────────────────────────
  async getBookingRevisionsFeed() {
    return this.get('/booking_revisions?page[size]=100');
  }

  async acknowledgeBookingRevision(revisionId) {
    return this.post(`/booking_revisions/${revisionId}/acknowledge`, {});
  }

  // ── Webhook ────────────────────────────────────────────────
  async createWebhook(attrs) {
    return this.post('/webhooks', { webhook: attrs });
  }
}

// ────────────────────────────────────────────────────────────
// 2. ChannexOutbox — coda persistente + rate limiter
// ────────────────────────────────────────────────────────────
class ChannexOutbox {
  constructor(supabase) {
    this.supabase = supabase;
    this.client = new ChannexClient();
    this._processing = false;
    this._callsThisMinute = 0;
    this._minuteStart = Date.now();
  }

  // Aggiunge un job alla coda
  async enqueue(tipo, payload, propertyId) {
    const { error } = await this.supabase
      .from('channex_outbox')
      .insert({ tipo, payload, property_id: propertyId, stato: 'pending', tentativi: 0 });
    if (error) console.error('[Outbox] Errore enqueue:', error.message);
  }

  // Processa la coda rispettando il rate limit
  async flush() {
    if (this._processing) return;
    this._processing = true;
    try {
      await this._processQueue();
    } finally {
      this._processing = false;
    }
  }

  async _processQueue() {
    const { data: jobs } = await this.supabase
      .from('channex_outbox')
      .select('*')
      .eq('stato', 'pending')
      .lt('tentativi', 5)
      .order('created_at', { ascending: true })
      .limit(50);

    if (!jobs || jobs.length === 0) return;

    for (const job of jobs) {
      await this._waitForRateLimit();
      await this._processJob(job);
    }
  }

  async _processJob(job) {
    try {
      let result;
      if (job.tipo === 'restrictions') {
        result = await this.client.pushRestrictions(job.payload.values);
      } else if (job.tipo === 'availability') {
        result = await this.client.pushAvailability(job.payload.values);
      } else {
        throw new Error(`Tipo job sconosciuto: ${job.tipo}`);
      }

      const taskIds = (result?.data || []).map(d => d.id);
      await this.supabase
        .from('channex_outbox')
        .update({ stato: 'done', task_ids: taskIds, elaborato_at: new Date().toISOString() })
        .eq('id', job.id);

      this._callsThisMinute++;
      console.log(`[Outbox] Job ${job.id} (${job.tipo}) completato. Task IDs: ${taskIds.join(', ')}`);
    } catch (err) {
      const nuoviTentativi = (job.tentativi || 0) + 1;
      const nuovoStato = nuoviTentativi >= 5 ? 'failed' : 'pending';
      await this.supabase
        .from('channex_outbox')
        .update({ tentativi: nuoviTentativi, stato: nuovoStato, errore: err.message })
        .eq('id', job.id);
      console.error(`[Outbox] Job ${job.id} fallito (tentativo ${nuoviTentativi}): ${err.message}`);
    }
  }

  async _waitForRateLimit() {
    const now = Date.now();
    if (now - this._minuteStart >= 60000) {
      // Nuovo minuto → reset contatore
      this._callsThisMinute = 0;
      this._minuteStart = now;
    }
    if (this._callsThisMinute >= RATE_LIMIT_PER_MINUTE) {
      const attesaMs = 60000 - (now - this._minuteStart) + 100;
      console.log(`[Outbox] Rate limit raggiunto — attendo ${attesaMs}ms`);
      await sleep(attesaMs);
      this._callsThisMinute = 0;
      this._minuteStart = Date.now();
    }
  }
}

// ────────────────────────────────────────────────────────────
// 3. ChannexSync — Full Sync e Delta Push
// ────────────────────────────────────────────────────────────
class ChannexSync {
  constructor(supabase, outbox) {
    this.supabase = supabase;
    this.outbox = outbox;
    this.client = new ChannexClient();
  }

  // Recupera il mapping Gestaway → Channex per una struttura
  async getMapping(gId) {
    const { data, error } = await this.supabase
      .from('channex_mappings')
      .select('*')
      .eq('gestaway_property_id', gId)
      .single();
    if (error || !data) return null;
    return data;
  }

  // Recupera il mapping di una camera
  async getRoomMapping(gestRoomId) {
    const { data } = await this.supabase
      .from('channex_room_mappings')
      .select('*')
      .eq('gestaway_room_id', gestRoomId)
      .single();
    return data;
  }

  // ── Full Sync ─────────────────────────────────────────────
  // Manda 500 giorni di ARI a Channex in 2 chiamate:
  // 1. POST /availability (tutti i room types)
  // 2. POST /restrictions (tutti i rate plans)
  async fullSync(gPropertyId) {
    const mapping = await this.getMapping(gPropertyId);
    if (!mapping) throw new Error(`Nessun mapping Channex per la struttura ${gPropertyId}`);

    const { data: camere } = await this.supabase
      .from('channex_room_mappings')
      .select('*')
      .eq('gestaway_property_id', gPropertyId);

    const { data: tariffe } = await this.supabase
      .from('channex_rate_mappings')
      .select('*')
      .eq('gestaway_property_id', gPropertyId);

    if (!camere?.length || !tariffe?.length) {
      throw new Error('Nessuna camera o tariffa mappata — completa il mapping prima di fare il Full Sync');
    }

    const oggi = new Date();
    const fine = new Date(oggi);
    fine.setDate(fine.getDate() + 500);
    const dateFrom = formatDate(oggi);
    const dateTo = formatDate(fine);

    // Chiamata 1: Disponibilità (1 entry per room type)
    const availValues = camere.map(c => ({
      property_id: mapping.channex_property_id,
      room_type_id: c.channex_room_type_id,
      date_from: dateFrom,
      date_to: dateTo,
      availability: c.disponibilita_default ?? 1,
    }));

    // Chiamata 2: Tariffe + restrizioni (1 entry per rate plan)
    const rateValues = tariffe.map(t => ({
      property_id: mapping.channex_property_id,
      rate_plan_id: t.channex_rate_plan_id,
      date_from: dateFrom,
      date_to: dateTo,
      rate: Math.round((t.prezzo_default ?? 100) * 100), // in centesimi
      min_stay: t.min_stay_default ?? 1,
    }));

    await this.outbox.enqueue('availability', { values: availValues }, gPropertyId);
    await this.outbox.enqueue('restrictions', { values: rateValues }, gPropertyId);
    await this.outbox.flush();

    // Registra l'ora dell'ultimo full sync
    await this.supabase
      .from('channex_mappings')
      .update({ ultimo_full_sync: new Date().toISOString() })
      .eq('gestaway_property_id', gPropertyId);

    console.log(`[Sync] Full Sync completato per struttura ${gPropertyId}`);
  }

  // ── Delta Push Availability ───────────────────────────────
  // Chiamato quando cambia la disponibilità di una camera
  async pushAvailabilityDelta(gPropertyId, gRoomId, dateFrom, dateTo, nuovaDisponibilita) {
    const mapping = await this.getMapping(gPropertyId);
    if (!mapping) return;

    const roomMap = await this.getRoomMapping(gRoomId);
    if (!roomMap) return;

    const value = {
      property_id: mapping.channex_property_id,
      room_type_id: roomMap.channex_room_type_id,
      date_from: dateFrom,
      date_to: dateTo,
      availability: nuovaDisponibilita,
    };

    await this.outbox.enqueue('availability', { values: [value] }, gPropertyId);
    await this.outbox.flush();
  }

  // ── Delta Push Tariffe/Restrizioni ────────────────────────
  // Chiamato quando cambia prezzo o restrizione su un rate plan
  async pushRestrictionsDelta(gPropertyId, changes) {
    // changes: array di { ratePlanId_channex, dateFrom, dateTo, rate?, min_stay?, stop_sell?, ... }
    const mapping = await this.getMapping(gPropertyId);
    if (!mapping) return;

    const values = changes.map(ch => ({
      property_id: mapping.channex_property_id,
      rate_plan_id: ch.ratePlanId,
      date_from: ch.dateFrom,
      date_to: ch.dateTo,
      ...(ch.rate        != null && { rate: Math.round(ch.rate * 100) }),
      ...(ch.min_stay    != null && { min_stay: ch.min_stay }),
      ...(ch.max_stay    != null && { max_stay: ch.max_stay }),
      ...(ch.stop_sell   != null && { stop_sell: ch.stop_sell }),
      ...(ch.closed_to_arrival   != null && { closed_to_arrival: ch.closed_to_arrival }),
      ...(ch.closed_to_departure != null && { closed_to_departure: ch.closed_to_departure }),
    }));

    await this.outbox.enqueue('restrictions', { values }, gPropertyId);
    await this.outbox.flush();
  }
}

// ────────────────────────────────────────────────────────────
// 4. ChannexBookings — Polling Feed + Acknowledge
// ────────────────────────────────────────────────────────────
class ChannexBookings {
  constructor(supabase) {
    this.supabase = supabase;
    this.client = new ChannexClient();
    this._poller = null;
  }

  // Avvia il polling ogni 15 minuti
  startPolling() {
    if (this._poller) return;
    console.log('[Bookings] Polling Channex Booking Revision Feed avviato (ogni 15 min)');
    this._poller = setInterval(() => this.poll(), BOOKING_POLL_INTERVAL_MS);
    // Prima esecuzione immediata
    this.poll().catch(err => console.error('[Bookings] Errore poll iniziale:', err.message));
  }

  stopPolling() {
    if (this._poller) { clearInterval(this._poller); this._poller = null; }
  }

  async poll() {
    try {
      const feed = await this.client.getBookingRevisionsFeed();
      const revisions = feed?.data || [];
      if (revisions.length === 0) return;

      console.log(`[Bookings] ${revisions.length} nuove booking revision da elaborare`);

      for (const rev of revisions) {
        await this._processRevision(rev);
      }
    } catch (err) {
      console.error('[Bookings] Errore durante il polling:', err.message);
    }
  }

  async _processRevision(rev) {
    const attrs = rev.attributes || rev;
    const revisionId = attrs.id || rev.id;
    const bookingId = attrs.booking_id;
    const status = attrs.status; // 'new' | 'modified' | 'cancelled'

    try {
      // Trova la struttura Gestaway corrispondente
      const { data: mapping } = await this.supabase
        .from('channex_mappings')
        .select('gestaway_property_id')
        .eq('channex_property_id', attrs.property_id)
        .single();

      const gPropertyId = mapping?.gestaway_property_id || null;

      // Salva / aggiorna la prenotazione in Supabase
      const bookingData = {
        channex_booking_id:   bookingId,
        channex_revision_id:  revisionId,
        channex_property_id:  attrs.property_id,
        gestaway_property_id: gPropertyId,
        stato: status,
        ota_name: attrs.ota_name,
        ota_reservation_code: attrs.ota_reservation_code,
        arrivo: attrs.arrival_date,
        partenza: attrs.departure_date,
        importo: attrs.amount,
        valuta: attrs.currency,
        ospite_nome: attrs.customer?.name,
        ospite_cognome: attrs.customer?.surname,
        ospite_email: attrs.customer?.mail,
        ospite_telefono: attrs.customer?.phone,
        adulti: attrs.occupancy?.adults,
        bambini: attrs.occupancy?.children,
        note: attrs.notes,
        raw_payload: attrs,
      };

      if (status === 'cancelled') {
        await this.supabase
          .from('channex_prenotazioni')
          .update({ stato: 'cancelled', raw_payload: attrs })
          .eq('channex_booking_id', bookingId);
      } else {
        await this.supabase
          .from('channex_prenotazioni')
          .upsert(bookingData, { onConflict: 'channex_booking_id' });
      }

      // ACKNOWLEDGE obbligatorio — va fatto solo dopo aver salvato
      await this.client.acknowledgeBookingRevision(revisionId);
      console.log(`[Bookings] Prenotazione ${bookingId} (${status}) salvata e acknowledged ✓`);
    } catch (err) {
      console.error(`[Bookings] Errore su revision ${revisionId}:`, err.message);
      // Non fare acknowledge se c'è stato un errore di salvataggio
    }
  }
}

// ────────────────────────────────────────────────────────────
// Utility
// ────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function formatDate(d) { return d.toISOString().slice(0, 10); }

// ────────────────────────────────────────────────────────────
// Factory — crea e inizializza tutti i sottosistemi
// ────────────────────────────────────────────────────────────
function createChannexServices(supabase) {
  const outbox   = new ChannexOutbox(supabase);
  const sync     = new ChannexSync(supabase, outbox);
  const bookings = new ChannexBookings(supabase);
  const client   = new ChannexClient();

  return { outbox, sync, bookings, client };
}

module.exports = { createChannexServices, ChannexClient, formatDate };

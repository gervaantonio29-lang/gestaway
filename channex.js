// ============================================================
// GESTAWAY — channex.js
// ============================================================
const https = require('https');
const CHANNEX_BASE = process.env.CHANNEX_ENV === 'production'
  ? 'https://app.channex.io/api/v1'
  : 'https://staging.channex.io/api/v1';
const CHANNEX_API_KEY = process.env.CHANNEX_API_KEY;
const RATE_LIMIT_PER_MINUTE = 18;
const BOOKING_POLL_INTERVAL_MS = 15 * 60 * 1000;

class ChannexClient {
  constructor(apiKey = CHANNEX_API_KEY, baseUrl = CHANNEX_BASE) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }
  _requestRaw(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + path);
      const payload = body ? JSON.stringify(body) : null;
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers: { 'Content-Type': 'application/json', 'user-api-key': this.apiKey },
      };
      if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(data || '{}') }); }
          catch(e) { reject(new Error('Risposta Channex non valida: ' + data.slice(0, 200))); }
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  async _request(method, path, body = null, retries = 3) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const { status, data } = await this._requestRaw(method, path, body);
      if (status === 429) {
        if (attempt === retries) throw new Error('Channex rate limit: troppi tentativi');
        const waitMs = Math.pow(2, attempt + 1) * 1000;
        console.warn(`[Channex] 429 — attendo ${waitMs}ms`);
        await sleep(waitMs); continue;
      }
      if (status >= 500) {
        if (attempt === retries) throw new Error(`Channex server error ${status}`);
        await sleep(Math.pow(2, attempt) * 1000); continue;
      }
      if (status === 401) throw new Error('Channex: API key non valida');
      if (status >= 400) throw new Error(`Channex error ${status}: ${JSON.stringify(data)}`);
      return data;
    }
  }
  get(path)        { return this._request('GET', path); }
  post(path, body) { return this._request('POST', path, body); }
  put(path, body)  { return this._request('PUT', path, body); }
  delete(path)     { return this._request('DELETE', path); }
  async listProperties()          { return this.get('/properties'); }
  async createProperty(attrs)     { return this.post('/properties', { property: attrs }); }
  async createRoomType(attrs)     { return this.post('/room_types', { room_type: attrs }); }
  async createRatePlan(attrs)     { return this.post('/rate_plans', { rate_plan: attrs }); }
  async listRoomTypes(propertyId) { return this.get(`/room_types?filter[property_id]=${propertyId}`); }
  async listRatePlans(propertyId) { return this.get(`/rate_plans?filter[property_id]=${propertyId}`); }
  async pushRestrictions(values)  { return this.post('/restrictions', { values }); }
  async pushAvailability(values)  { return this.post('/availability', { values }); }
  async getBookingRevisionsFeed() { return this.get('/booking_revisions/feed?page[size]=100'); }
  async acknowledgeBookingRevision(revisionId) { return this.post(`/booking_revisions/${revisionId}/ack`, null); }
  async createWebhook(attrs)      { return this.post('/webhooks', { webhook: attrs }); }
}

class ChannexOutbox {
  constructor(supabase) {
    this.supabase = supabase;
    this.client = new ChannexClient();
    this._processing = false;
    this._callsThisMinute = 0;
    this._minuteStart = Date.now();
  }
  async enqueue(tipo, payload, propertyId) {
    const { error } = await this.supabase.from('channex_outbox').insert({ tipo, payload, property_id: propertyId, struttura_id: propertyId, stato: 'pending', tentativi: 0 });
    if (error) console.error('[Outbox] Errore enqueue:', error.message);
  }
  async flush() {
    if (this._processing) return;
    this._processing = true;
    const resetTimer = setTimeout(() => { this._processing = false; }, 60000);
    try { await this._processQueue(); }
    catch(err) { console.error('[Outbox] Errore nel flush:', err.message); }
    finally { clearTimeout(resetTimer); this._processing = false; }
  }
  async _processQueue() {
    const { data: jobs } = await this.supabase.from('channex_outbox').select('*').eq('stato', 'pending').lt('tentativi', 5).order('created_at', { ascending: true }).limit(50);
    if (!jobs || jobs.length === 0) return;
    for (const job of jobs) { await this._waitForRateLimit(); await this._processJob(job); }
  }
  async _processJob(job) {
    try {
      let result;
      if (job.tipo === 'restrictions') result = await this.client.pushRestrictions(job.payload.values);
      else if (job.tipo === 'availability') result = await this.client.pushAvailability(job.payload.values);
      else throw new Error(`Tipo job sconosciuto: ${job.tipo}`);
      console.log(`[Outbox] Raw response: ${JSON.stringify(result)}`);
      const taskIds = result?.data ? (Array.isArray(result.data) ? result.data.map(d => d.id) : [result.data.id]) : result?.id ? [result.id] : [];
      await this.supabase.from('channex_outbox').update({ stato: 'done', task_ids: taskIds, elaborato_at: new Date().toISOString() }).eq('id', job.id);
      this._callsThisMinute++;
      console.log(`[Outbox] Job ${job.id} (${job.tipo}) completato. Task IDs: ${taskIds.join(', ')}`);
    } catch (err) {
      const nuoviTentativi = (job.tentativi || 0) + 1;
      await this.supabase.from('channex_outbox').update({ tentativi: nuoviTentativi, stato: nuoviTentativi >= 5 ? 'failed' : 'pending', errore: err.message }).eq('id', job.id);
      console.error(`[Outbox] Job ${job.id} fallito (tentativo ${nuoviTentativi}): ${err.message}`);
    }
  }
  async _waitForRateLimit() {
    const now = Date.now();
    if (now - this._minuteStart >= 60000) { this._callsThisMinute = 0; this._minuteStart = now; }
    if (this._callsThisMinute >= RATE_LIMIT_PER_MINUTE) {
      const attesaMs = 60000 - (now - this._minuteStart) + 100;
      console.log(`[Outbox] Rate limit raggiunto — attendo ${attesaMs}ms`);
      await sleep(attesaMs);
      this._callsThisMinute = 0;
      this._minuteStart = Date.now();
    }
  }
}

class ChannexSync {
  constructor(supabase, outbox) {
    this.supabase = supabase;
    this.outbox = outbox;
    this.client = new ChannexClient();
  }
  async getMapping(gId) {
    const { data, error } = await this.supabase.from('channex_mappings').select('*').eq('gestaway_property_id', gId).single();
    if (error || !data) return null;
    return data;
  }
  async getRoomMapping(gestRoomId) {
    const { data } = await this.supabase.from('channex_room_mappings').select('*').eq('gestaway_room_id', gestRoomId).single();
    return data;
  }
  async calcolaSegmentiDisponibilita(appartamentoId, maxDisponibilita, dateFrom, dateTo) {
    const { data: prenAttive } = await this.supabase.from('prenotazioni').select('data_arrivo, data_partenza').eq('appartamento_id', appartamentoId).neq('stato', 'cancellata').lt('data_arrivo', dateTo).gt('data_partenza', dateFrom);
    const delta = new Map();
    for (const p of (prenAttive || [])) {
      const arrivo = p.data_arrivo < dateFrom ? dateFrom : p.data_arrivo;
      const partenza = p.data_partenza > dateTo ? dateTo : p.data_partenza;
      if (partenza <= arrivo) continue;
      delta.set(arrivo, (delta.get(arrivo) || 0) + 1);
      delta.set(partenza, (delta.get(partenza) || 0) - 1);
    }
    const puntiOrdinati = [...delta.keys()].sort();
    const segmenti = [];
    let occupate = 0, inizioSegmento = dateFrom;
    for (const punto of puntiOrdinati) {
      if (punto > inizioSegmento) segmenti.push({ date_from: inizioSegmento, date_to: punto, availability: Math.max(0, maxDisponibilita - occupate) });
      occupate += delta.get(punto);
      inizioSegmento = punto;
    }
    if (inizioSegmento < dateTo) segmenti.push({ date_from: inizioSegmento, date_to: dateTo, availability: Math.max(0, maxDisponibilita - occupate) });
    return segmenti;
  }
  async fullSync(gPropertyId) {
    const mapping = await this.getMapping(gPropertyId);
    if (!mapping) throw new Error(`Nessun mapping Channex per la struttura ${gPropertyId}`);
    const { data: camere } = await this.supabase.from('channex_room_mappings').select('*').eq('gestaway_property_id', gPropertyId);
    if (!camere?.length) throw new Error('Nessuna camera mappata');
    const oggi = new Date();
    const fine = new Date(oggi); fine.setDate(fine.getDate() + 500);
    const dateFrom = formatDate(oggi), dateTo = formatDate(fine);
    const availValues = [];
    for (const c of (camere || [])) {
      const maxDisponibilita = c.disponibilita_default ?? 1;
      const appartamentoId = c.gestaway_room_id;
      if (appartamentoId) {
        const segmenti = await this.calcolaSegmentiDisponibilita(appartamentoId, maxDisponibilita, dateFrom, dateTo);
        for (const s of segmenti) availValues.push({ property_id: mapping.channex_property_id, room_type_id: c.channex_room_type_id, date_from: s.date_from, date_to: s.date_to, availability: s.availability });
      } else {
        availValues.push({ property_id: mapping.channex_property_id, room_type_id: c.channex_room_type_id, date_from: dateFrom, date_to: dateTo, availability: maxDisponibilita });
      }
    }
    // NOTA: fullSync aggiorna SOLO la disponibilita' (occupato/libero), mai tariffe
    // o restrizioni (min stay, prezzi). Quelle si gestiscono solo manualmente dal
    // Channel Manager, per non sovrascrivere regole come il minimo notti weekend.
    await this.outbox.enqueue('availability', { values: availValues }, gPropertyId);
    await this.outbox.flush();
    await this.supabase.from('channex_mappings').update({ ultimo_full_sync: new Date().toISOString() }).eq('gestaway_property_id', gPropertyId);
    console.log(`[Sync] Full Sync completato per struttura ${gPropertyId}`);
  }
  async pushAvailabilityDelta(gPropertyId, gRoomId, dateFrom, dateTo, nuovaDisponibilita) {
    const mapping = await this.getMapping(gPropertyId);
    if (!mapping) return;
    const roomMap = await this.getRoomMapping(gRoomId);
    if (!roomMap) return;
    await this.outbox.enqueue('availability', { values: [{ property_id: mapping.channex_property_id, room_type_id: roomMap.channex_room_type_id, date_from: dateFrom, date_to: dateTo, availability: nuovaDisponibilita }] }, gPropertyId);
    await this.outbox.flush();
  }
  async pushRestrictionsDelta(gPropertyId, changes) {
    const mapping = await this.getMapping(gPropertyId);
    if (!mapping) return;
    const values = changes.map(ch => ({ property_id: mapping.channex_property_id, rate_plan_id: ch.ratePlanId, date_from: ch.dateFrom, date_to: ch.dateTo, ...(ch.rate != null && { rate: Math.round(ch.rate * 100) }), ...(ch.min_stay != null && { min_stay: ch.min_stay }), ...(ch.max_stay != null && { max_stay: ch.max_stay }), ...(ch.stop_sell != null && { stop_sell: ch.stop_sell }), ...(ch.closed_to_arrival != null && { closed_to_arrival: ch.closed_to_arrival }), ...(ch.closed_to_departure != null && { closed_to_departure: ch.closed_to_departure }) }));
    await this.outbox.enqueue('restrictions', { values }, gPropertyId);
    await this.outbox.flush();
  }
}

class ChannexBookings {
  constructor(supabase, outbox) {
    this.supabase = supabase;
    this.client = new ChannexClient();
    this.outbox = outbox;
    this._poller = null;
    this._polling = false;
  }
  startPolling() {
    if (this._poller) return;
    console.log('[Bookings] Polling Channex Booking Revision Feed avviato (ogni 15 min)');
    this._poller = setInterval(() => this.poll(), BOOKING_POLL_INTERVAL_MS);
    this.poll().catch(err => console.error('[Bookings] Errore poll iniziale:', err.message));
  }
  stopPolling() {
    if (this._poller) { clearInterval(this._poller); this._poller = null; }
  }
  async poll() {
    if (this._polling) return;
    this._polling = true;
    try {
      const feed = await this.client.getBookingRevisionsFeed();
      const revisions = feed?.data || [];
      if (revisions.length === 0) return;
      console.log(`[Bookings] ${revisions.length} nuove booking revision da elaborare`);
      for (const rev of revisions) await this._processRevision(rev);
    } catch (err) {
      console.error('[Bookings] Errore durante il polling:', err.message);
    } finally {
      this._polling = false;
    }
  }
  async _getAppartamentoId(gPropertyId, attrs) {
    const roomTypeId = attrs.rooms?.[0]?.room_type_id;
    if (roomTypeId) {
      const { data: roomMap } = await this.supabase.from('channex_room_mappings').select('gestaway_room_id')
        .eq('gestaway_property_id', gPropertyId).eq('channex_room_type_id', roomTypeId).single();
      if (roomMap?.gestaway_room_id) return roomMap.gestaway_room_id;
      console.warn(`[Bookings] Nessuna mappatura camera per room_type_id ${roomTypeId} (struttura ${gPropertyId}) — uso il primo appartamento disponibile`);
    }
    const { data: primoApt } = await this.supabase.from('appartamenti').select('id').eq('struttura_id', gPropertyId).order('created_at').limit(1).single();
    return primoApt?.id || null;
  }
  async _processRevision(rev) {
    const attrs = rev.attributes || rev;
    const revisionId = attrs.id || rev.id;
    const bookingId = attrs.booking_id;
    const status = attrs.status;
    try {
      const { data: mapping } = await this.supabase.from('channex_mappings').select('gestaway_property_id').eq('channex_property_id', attrs.property_id).single();
      const gPropertyId = mapping?.gestaway_property_id || null;
      try {
        await this.supabase.from('channex_revision_log').insert({ booking_id: bookingId, revision_id: revisionId, status, property_id: attrs.property_id || null, struttura_id: gPropertyId });
      } catch(logErr) { console.warn('[Bookings] Revision log error:', logErr.message); }

      if (!gPropertyId) {
        console.error(`[Bookings] Nessuna struttura mappata per property Channex ${attrs.property_id} — booking ${bookingId} ignorato`);
        // Ack comunque: la feed è condivisa fra tutte le strutture, altrimenti
        // questa revision verrebbe riscaricata e rilogata ad ogni poll per sempre.
        try { await this.client.acknowledgeBookingRevision(revisionId); }
        catch (ackErr) { if (!ackErr.message.includes('404')) console.error(`[Bookings] Errore ack revision non mappata ${revisionId}:`, ackErr.message); }
        return;
      }

      const bookingData = {
        channex_booking_id: bookingId, channex_revision_id: revisionId,
        channex_property_id: attrs.property_id, gestaway_property_id: gPropertyId, struttura_id: gPropertyId,
        stato: status, ota_name: attrs.ota_name, ota_reservation_code: attrs.ota_reservation_code,
        arrivo: attrs.arrival_date, partenza: attrs.departure_date,
        importo: attrs.amount, valuta: attrs.currency,
        ospite_nome: attrs.customer?.name, ospite_cognome: attrs.customer?.surname,
        ospite_email: attrs.customer?.mail, ospite_telefono: attrs.customer?.phone,
        adulti: attrs.occupancy?.adults, bambini: attrs.occupancy?.children,
        note: attrs.notes, raw_payload: attrs,
      };

      // Salva SEMPRE in channex_prenotazioni (anche se cancelled) per avere le date
      await this.supabase.from('channex_prenotazioni').upsert(bookingData, { onConflict: 'channex_booking_id' });

      const appartamentoId = await this._getAppartamentoId(gPropertyId, attrs);

      if (status === 'cancelled') {
        // Cancella in prenotazioni (scoped per struttura)
        await this.supabase.from('prenotazioni').update({ stato: 'cancellata' }).eq('uid', 'channex_' + bookingId).eq('struttura_id', gPropertyId);

        // Recupera le date — prima da attrs, poi da channex_prenotazioni se attrs non le ha
        let arrivo = attrs.arrival_date;
        let partenza = attrs.departure_date;
        if (!arrivo || !partenza) {
          const { data: existing } = await this.supabase.from('channex_prenotazioni').select('arrivo, partenza').eq('channex_booking_id', bookingId).single();
          arrivo = existing?.arrivo;
          partenza = existing?.partenza;
        }

        // Rimanda stop_sell se le date sono ancora occupate da altre prenotazioni della stessa struttura/appartamento
        if (arrivo && partenza && appartamentoId) {
          try {
            const { data: prenAttive } = await this.supabase
              .from('prenotazioni')
              .select('id')
              .eq('struttura_id', gPropertyId)
              .eq('appartamento_id', appartamentoId)
              .neq('stato', 'cancellata')
              .lt('data_arrivo', partenza)
              .gt('data_partenza', arrivo);
            if (prenAttive && prenAttive.length > 0) {
              const { data: rateMappings } = await this.supabase
                .from('channex_rate_mappings')
                .select('channex_rate_plan_id')
                .eq('gestaway_property_id', gPropertyId);
              if (rateMappings?.length) {
                const values = rateMappings.map(r => ({
                  property_id: attrs.property_id,
                  rate_plan_id: r.channex_rate_plan_id,
                  date_from: arrivo,
                  date_to: partenza,
                  stop_sell: true,
                  min_stay_arrival: 1, min_stay_through: 1, max_stay: 30,
                  closed_to_arrival: false, closed_to_departure: false,
                }));
                await this.outbox.enqueue('restrictions', { values }, gPropertyId);
                await this.outbox.flush();
                console.log(`[Bookings] ✅ Stop-sell rimandato per ${arrivo} → ${partenza} (cancellata ${bookingId})`);
              }
            } else {
              console.log(`[Bookings] Date ${arrivo} → ${partenza} liberate correttamente`);
            }
          } catch(stopErr) {
            console.error('[Bookings] Errore rimando stop-sell:', stopErr.message);
          }
        }
      } else {
        // Salva in prenotazioni per il calendario
        const ospiteNome = [attrs.customer?.name, attrs.customer?.surname].filter(Boolean).join(' ') || 'Ospite';
        const ota = (attrs.ota_name || '').toLowerCase();
        const fonte = ota.includes('booking') ? 'Booking' : ota.includes('airbnb') ? 'Airbnb' : 'Channex';
        await this.supabase.from('prenotazioni').upsert({
          uid: 'channex_' + bookingId,
          struttura_id: gPropertyId,
          ospite: ospiteNome,
          email_ospite: attrs.customer?.mail || null,
          telefono_ospite: attrs.customer?.phone || null,
          data_arrivo: attrs.arrival_date,
          data_partenza: attrs.departure_date,
          fonte, importo: attrs.amount || null,
          stato: 'confermata', questura_inviata: 0,
          appartamento_id: appartamentoId,
          note: attrs.ota_reservation_code ? `Codice OTA: ${attrs.ota_reservation_code}` : null,
        }, { onConflict: 'struttura_id,uid' });
        // Invia messaggio automatico di conferma per nuove prenotazioni, se la struttura ne ha configurato uno
        if (status === 'new') {
          try {
            const { data: msgCfg } = await this.supabase.from('impostazioni').select('valore').eq('struttura_id', gPropertyId).eq('chiave', 'messaggio_benvenuto').single();
            if (msgCfg?.valore) {
              await this.client.post('/bookings/' + bookingId + '/messages', {
                message: { message: msgCfg.valore.replace('{ospite}', ospiteNome) }
              });
              console.log('[Messaggi] Conferma inviata per ' + bookingId);
            }
          } catch(msgErr) {
            console.warn('[Messaggi] Errore conferma:', msgErr.message);
          }
        }
      }

      try {
        await this.client.acknowledgeBookingRevision(revisionId);
        console.log(`[Bookings] Prenotazione ${bookingId} (${status}) salvata e acknowledged ✓`);
      } catch (ackErr) {
        if (ackErr.message.includes('404')) console.warn(`[Bookings] Revision ${revisionId} non acknowledgeabile (404) — skippata`);
        else throw ackErr;
      }
    } catch (err) {
      console.error(`[Bookings] Errore su revision ${revisionId}:`, err.message);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function formatDate(d) { return d.toISOString().slice(0, 10); }

function createChannexServices(supabase) {
  const outbox   = new ChannexOutbox(supabase);
  const sync     = new ChannexSync(supabase, outbox);
  const bookings = new ChannexBookings(supabase, outbox);
  const client   = new ChannexClient();
  return { outbox, sync, bookings, client };
}
module.exports = { createChannexServices, ChannexClient, formatDate };

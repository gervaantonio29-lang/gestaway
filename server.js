// ============================================================
// GESTAWAY — server.js
// Stack: Express + Supabase + Channex.io
// ============================================================

require('dotenv').config();
const express       = require('express');
const cors          = require('cors');
const cookieParser  = require('cookie-parser');
const { createClient } = require('@supabase/supabase-js');
const { createChannexServices, ChannexClient } = require('./channex');

const app  = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_COOKIE = 'gc_session';
const sessioniValide = new Set();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// ── Channex services ─────────────────────────────────────────
const channex = createChannexServices(supabase);

// Avvia il polling prenotazioni solo se la chiave Channex è configurata
if (process.env.CHANNEX_API_KEY) {
  channex.bookings.startPolling();
} else {
  console.warn('[Channex] CHANNEX_API_KEY non impostata — polling prenotazioni disabilitato');
}

// ────────────────────────────────────────────────────────────
// AUTH
// ────────────────────────────────────────────────────────────
function generaToken() {
  return require('crypto').randomBytes(32).toString('hex');
}

function richiedeLogin(req, res, next) {
  const token = req.cookies[SESSION_COOKIE];
  if (token && sessioniValide.has(token)) return next();
  return res.status(401).json({ errore: 'Accesso non autorizzato. Effettua il login.' });
}

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (!ADMIN_PASSWORD) return res.status(500).json({ errore: 'ADMIN_PASSWORD non configurata.' });
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ errore: 'Password non corretta.' });
  const token = generaToken();
  sessioniValide.add(token);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies[SESSION_COOKIE];
  if (token) sessioniValide.delete(token);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

app.get('/api/sessione', (req, res) => {
  const token = req.cookies[SESSION_COOKIE];
  res.json({ autenticato: !!(token && sessioniValide.has(token)) });
});

// ── Webhook Channex (FUORI dal middleware auth: Channex chiama direttamente)
// Deve essere dichiarato PRIMA di app.use('/api', richiedeLogin)
app.post('/api/channex/webhook', express.json(), async (req, res) => {
  try {
    const payload = req.body;
    const event = payload?.event || payload?.type;

    // Log dell'evento in arrivo
    await supabase.from('channex_log').insert({
      tipo: 'webhook',
      dettagli: payload,
      esito: 'ok',
      messaggio: `Webhook ricevuto: ${event}`,
    });

    // Gestione eventi booking
    if (event === 'booking' || event === 'BookingRevision' || payload?.booking_id) {
      // Triggera immediatamente un poll per raccogliere le nuove revisioni
      channex.bookings.poll().catch(err =>
        console.error('[Webhook] Errore poll post-webhook:', err.message)
      );
    }

    // Channex richiede risposta 200 OK entro pochi secondi
    res.json({ ok: true });
  } catch (err) {
    console.error('[Webhook] Errore:', err.message);
    res.status(500).json({ errore: err.message });
  }
});

// Tutte le rotte /api/* sotto questa riga richiedono login
app.use('/api', richiedeLogin);

// ────────────────────────────────────────────────────────────
// CONDOMINI (invariato)
// ────────────────────────────────────────────────────────────
app.get('/api/condomini', async (req, res) => {
  const { data, error } = await supabase.from('condomini').select('*').order('created_at', { ascending: true });
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.post('/api/condomini', async (req, res) => {
  const { nome, indirizzo, codice_fiscale, iban } = req.body;
  if (!nome) return res.status(400).json({ errore: 'Il nome del condominio è obbligatorio.' });
  const { data, error } = await supabase
    .from('condomini').insert({ nome, indirizzo, codice_fiscale, iban }).select().single();
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.put('/api/condomini/:id', async (req, res) => {
  const { nome, indirizzo, codice_fiscale, iban } = req.body;
  const { data, error } = await supabase
    .from('condomini').update({ nome, indirizzo, codice_fiscale, iban })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.delete('/api/condomini/:id', async (req, res) => {
  const { error } = await supabase.from('condomini').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ errore: error.message });
  res.json({ ok: true });
});

// ────────────────────────────────────────────────────────────
// UNITA' (invariato)
// ────────────────────────────────────────────────────────────
app.get('/api/condomini/:condominioId/unita', async (req, res) => {
  const { data, error } = await supabase
    .from('unita').select('*').eq('condominio_id', req.params.condominioId)
    .order('interno', { ascending: true });
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.post('/api/condomini/:condominioId/unita', async (req, res) => {
  const { interno, piano, proprietario, email, telefono, millesimi,
          catasto_foglio, catasto_particella, catasto_subalterno } = req.body;
  if (!interno || !proprietario || millesimi == null)
    return res.status(400).json({ errore: 'Interno, proprietario e millesimi sono obbligatori.' });

  const { data, error } = await supabase.from('unita').insert({
    condominio_id: req.params.condominioId,
    interno, piano: piano || null, proprietario, email, telefono,
    millesimi: Number(millesimi),
    catasto_foglio: catasto_foglio || null,
    catasto_particella: catasto_particella || null,
    catasto_subalterno: catasto_subalterno || null,
  }).select().single();
  if (error) return res.status(500).json({ errore: error.message });

  await supabase.from('titolari').insert({
    unita_id: data.id, nome: proprietario, tipo: 'proprietario', email, telefono,
  });
  res.json(data);
});

app.put('/api/unita/:id', async (req, res) => {
  const { interno, piano, proprietario, email, telefono, millesimi,
          catasto_foglio, catasto_particella, catasto_subalterno } = req.body;
  const { data, error } = await supabase.from('unita').update({
    interno, piano, proprietario, email, telefono, millesimi: Number(millesimi),
    catasto_foglio: catasto_foglio || null,
    catasto_particella: catasto_particella || null,
    catasto_subalterno: catasto_subalterno || null,
  }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.delete('/api/unita/:id', async (req, res) => {
  const { error } = await supabase.from('unita').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ errore: error.message });
  res.json({ ok: true });
});

// ────────────────────────────────────────────────────────────
// TITOLARI (invariato)
// ────────────────────────────────────────────────────────────
app.get('/api/unita/:unitaId/titolari', async (req, res) => {
  const { data, error } = await supabase.from('titolari').select('*')
    .eq('unita_id', req.params.unitaId).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.post('/api/unita/:unitaId/titolari', async (req, res) => {
  const { nome, tipo, codice_fiscale, email, telefono, percentuale } = req.body;
  const tipiValidi = ['proprietario','nudo_proprietario','usufruttuario','inquilino'];
  if (!nome) return res.status(400).json({ errore: 'Il nome è obbligatorio.' });
  if (tipo && !tipiValidi.includes(tipo)) return res.status(400).json({ errore: 'Tipo non valido.' });
  const { data, error } = await supabase.from('titolari').insert({
    unita_id: req.params.unitaId, nome, tipo: tipo || 'proprietario',
    codice_fiscale: codice_fiscale || null, email: email || null,
    telefono: telefono || null, percentuale: percentuale != null ? Number(percentuale) : null,
  }).select().single();
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.put('/api/titolari/:id', async (req, res) => {
  const { nome, tipo, codice_fiscale, email, telefono, percentuale } = req.body;
  const { data, error } = await supabase.from('titolari').update({
    nome, tipo, codice_fiscale: codice_fiscale || null, email: email || null,
    telefono: telefono || null, percentuale: percentuale != null ? Number(percentuale) : null,
  }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.delete('/api/titolari/:id', async (req, res) => {
  const { error } = await supabase.from('titolari').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ errore: error.message });
  res.json({ ok: true });
});

// ────────────────────────────────────────────────────────────
// SPESE (invariato)
// ────────────────────────────────────────────────────────────
app.get('/api/condomini/:condominioId/spese', async (req, res) => {
  const { data, error } = await supabase.from('spese').select('*')
    .eq('condominio_id', req.params.condominioId).order('data', { ascending: false });
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.post('/api/condomini/:condominioId/spese', async (req, res) => {
  const condominioId = req.params.condominioId;
  const { categoria, importo, data: dataSpesa, fornitore, note, giorni_scadenza } = req.body;
  if (!categoria || !importo || !dataSpesa)
    return res.status(400).json({ errore: 'Categoria, importo e data sono obbligatori.' });

  const importoNum     = Number(importo);
  const giorniScadenza = Number(giorni_scadenza) || 30;

  const { data: unitaCondominio, error: erroreUnita } = await supabase
    .from('unita').select('id, millesimi').eq('condominio_id', condominioId);
  if (erroreUnita) return res.status(500).json({ errore: erroreUnita.message });
  if (!unitaCondominio?.length)
    return res.status(400).json({ errore: 'Nessuna unità: impossibile ripartire.' });

  const { data: spesa, error: erroreSpesa } = await supabase.from('spese').insert({
    condominio_id: condominioId, categoria, importo: importoNum,
    data: dataSpesa, fornitore: fornitore || null, note: note || null,
    giorni_scadenza: giorniScadenza,
  }).select().single();
  if (erroreSpesa) return res.status(500).json({ errore: erroreSpesa.message });

  const scadenza = new Date(dataSpesa);
  scadenza.setDate(scadenza.getDate() + giorniScadenza);
  const scadenzaStr = scadenza.toISOString().slice(0, 10);

  const quoteDaInserire = unitaCondominio.map(u => ({
    spesa_id: spesa.id, unita_id: u.id, condominio_id: condominioId,
    importo: Math.round((importoNum * Number(u.millesimi) / 1000) * 100) / 100,
    scadenza: scadenzaStr, stato: 'da_emettere',
  }));

  const { error: erroreQuote } = await supabase.from('quote').insert(quoteDaInserire);
  if (erroreQuote) {
    await supabase.from('spese').delete().eq('id', spesa.id);
    return res.status(500).json({ errore: 'Errore ripartizione: ' + erroreQuote.message });
  }
  res.json(spesa);
});

app.delete('/api/spese/:id', async (req, res) => {
  const { error } = await supabase.from('spese').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ errore: error.message });
  res.json({ ok: true });
});

// ────────────────────────────────────────────────────────────
// QUOTE (invariato)
// ────────────────────────────────────────────────────────────
app.get('/api/condomini/:condominioId/quote', async (req, res) => {
  const { stato } = req.query;
  let query = supabase.from('quote')
    .select('*, spese(categoria, fornitore), unita(interno, proprietario, millesimi)')
    .eq('condominio_id', req.params.condominioId)
    .order('scadenza', { ascending: true });
  if (stato) query = query.eq('stato', stato);
  const { data, error } = await query;
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.put('/api/quote/:id/stato', async (req, res) => {
  const { stato } = req.body;
  const statiValidi = ['da_emettere','emesso','pagato','scaduto'];
  if (!statiValidi.includes(stato)) return res.status(400).json({ errore: 'Stato non valido.' });
  const aggiornamento = {
    stato,
    data_pagamento: stato === 'pagato' ? new Date().toISOString().slice(0, 10) : null,
  };
  const { data, error } = await supabase.from('quote').update(aggiornamento)
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

// ────────────────────────────────────────────────────────────
// DASHBOARD (invariato)
// ────────────────────────────────────────────────────────────
app.get('/api/condomini/:condominioId/dashboard', async (req, res) => {
  const condominioId = req.params.condominioId;
  const [{ data: spese, error: e1 }, { data: quote, error: e2 }, { data: unita, error: e3 }] =
    await Promise.all([
      supabase.from('spese').select('*').eq('condominio_id', condominioId),
      supabase.from('quote').select('*').eq('condominio_id', condominioId),
      supabase.from('unita').select('*').eq('condominio_id', condominioId),
    ]);
  if (e1 || e2 || e3) return res.status(500).json({ errore: (e1 || e2 || e3).message });

  const totSpesaAnno    = spese.reduce((s, sp) => s + Number(sp.importo), 0);
  const totIncassato    = quote.filter(q => q.stato === 'pagato').reduce((s, q) => s + Number(q.importo), 0);
  const totDaIncassare  = quote.filter(q => q.stato !== 'pagato').reduce((s, q) => s + Number(q.importo), 0);
  const numScaduti      = quote.filter(q => q.stato === 'scaduto').length;
  const totMillesimi    = unita.reduce((s, u) => s + Number(u.millesimi), 0);
  const speseCategoria  = {};
  spese.forEach(s => { speseCategoria[s.categoria] = (speseCategoria[s.categoria] || 0) + Number(s.importo); });

  res.json({
    totSpesaAnno, totIncassato, totDaIncassare, numScaduti, totMillesimi,
    numUnita: unita.length,
    speseCategoria: Object.entries(speseCategoria).map(([categoria, importo]) => ({ categoria, importo })),
  });
});

// ============================================================
// CHANNEX API — Mapping & Gestione
// ============================================================

// ── Mapping: lista strutture mappate ─────────────────────────
app.get('/api/channex/mappings', async (req, res) => {
  const { data, error } = await supabase.from('channex_mappings').select(`
    *,
    channex_room_mappings(*),
    channex_rate_mappings(*)
  `).order('created_at');
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

// ── Mapping: collega una struttura Gestaway a Channex ────────
app.post('/api/channex/mappings', async (req, res) => {
  const { gestaway_property_id, gestaway_nome, channex_property_id } = req.body;
  if (!gestaway_property_id || !channex_property_id)
    return res.status(400).json({ errore: 'gestaway_property_id e channex_property_id sono obbligatori.' });

  const { data, error } = await supabase.from('channex_mappings').upsert({
    gestaway_property_id, gestaway_nome: gestaway_nome || gestaway_property_id,
    channex_property_id,
  }, { onConflict: 'gestaway_property_id' }).select().single();
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

// ── Mapping: aggiungi camera ──────────────────────────────────
app.post('/api/channex/room-mappings', async (req, res) => {
  const { gestaway_property_id, gestaway_room_id, gestaway_room_nome,
          channex_room_type_id, channex_room_type_nome,
          disponibilita_default } = req.body;
  if (!gestaway_property_id || !gestaway_room_id || !channex_room_type_id)
    return res.status(400).json({ errore: 'Campi obbligatori mancanti.' });

  const { data, error } = await supabase.from('channex_room_mappings').upsert({
    gestaway_property_id, gestaway_room_id,
    gestaway_room_nome: gestaway_room_nome || gestaway_room_id,
    channex_room_type_id,
    channex_room_type_nome: channex_room_type_nome || '',
    disponibilita_default: disponibilita_default ?? 1,
  }, { onConflict: 'gestaway_room_id' }).select().single();
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

// ── Mapping: aggiungi tariffa ─────────────────────────────────
app.post('/api/channex/rate-mappings', async (req, res) => {
  const { gestaway_property_id, gestaway_room_id, channex_room_type_id,
          channex_rate_plan_id, channex_rate_plan_nome,
          prezzo_default, min_stay_default, valuta } = req.body;
  if (!gestaway_property_id || !channex_rate_plan_id)
    return res.status(400).json({ errore: 'Campi obbligatori mancanti.' });

  const { data, error } = await supabase.from('channex_rate_mappings').upsert({
    gestaway_property_id, gestaway_room_id: gestaway_room_id || null,
    channex_room_type_id: channex_room_type_id || null,
    channex_rate_plan_id,
    channex_rate_plan_nome: channex_rate_plan_nome || '',
    prezzo_default: prezzo_default ?? 100,
    min_stay_default: min_stay_default ?? 1,
    valuta: valuta || 'EUR',
  }, { onConflict: 'channex_rate_plan_id' }).select().single();
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

// ── Fetch strutture/camere/tariffe da Channex (per il mapping UI) ──
app.get('/api/channex/properties', async (req, res) => {
  try {
    const data = await channex.client.listProperties();
    res.json(data);
  } catch (err) {
    res.status(500).json({ errore: err.message });
  }
});

app.get('/api/channex/room-types/:propertyId', async (req, res) => {
  try {
    const data = await channex.client.listRoomTypes(req.params.propertyId);
    res.json(data);
  } catch (err) {
    res.status(500).json({ errore: err.message });
  }
});

app.get('/api/channex/rate-plans/:propertyId', async (req, res) => {
  try {
    const data = await channex.client.listRatePlans(req.params.propertyId);
    res.json(data);
  } catch (err) {
    res.status(500).json({ errore: err.message });
  }
});

// ── Full Sync ─────────────────────────────────────────────────
// Invia 500 giorni di ARI a Channex (test 1 della certificazione)
app.post('/api/channex/full-sync/:propertyId', async (req, res) => {
  try {
    await channex.sync.fullSync(req.params.propertyId);
    res.json({ ok: true, messaggio: 'Full sync completato e accodato correttamente.' });
  } catch (err) {
    res.status(500).json({ errore: err.message });
  }
});

// ── Delta Push ARI (chiamato dal PMS quando cambia qualcosa) ──
app.post('/api/channex/push-ari/:propertyId', async (req, res) => {
  const { tipo, values } = req.body;
  // tipo: 'restrictions' | 'availability'
  if (!tipo || !values?.length)
    return res.status(400).json({ errore: 'tipo e values[] sono obbligatori.' });

  try {
    await channex.outbox.enqueue(tipo, { values }, req.params.propertyId);
    await channex.outbox.flush();
    res.json({ ok: true, messaggio: `Delta push (${tipo}) accodato.` });
  } catch (err) {
    res.status(500).json({ errore: err.message });
  }
});

// ── Prenotazioni ricevute da Channex ──────────────────────────
app.get('/api/channex/prenotazioni', async (req, res) => {
  const { property_id, stato, limit = 50 } = req.query;
  let query = supabase.from('channex_prenotazioni')
    .select('*').order('arrivo', { ascending: false }).limit(Number(limit));
  if (property_id) query = query.eq('gestaway_property_id', property_id);
  if (stato)       query = query.eq('stato', stato);
  const { data, error } = await query;
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

// ── Trigger manuale polling prenotazioni ──────────────────────
app.post('/api/channex/poll-bookings', async (req, res) => {
  try {
    await channex.bookings.poll();
    res.json({ ok: true, messaggio: 'Polling completato.' });
  } catch (err) {
    res.status(500).json({ errore: err.message });
  }
});

// ── Crea property/room/rate su Channex via API ────────────────
app.post('/api/channex/create-property', async (req, res) => {
  try {
    const data = await channex.client.createProperty(req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ errore: err.message });
  }
});

app.post('/api/channex/create-room-type', async (req, res) => {
  try {
    const data = await channex.client.createRoomType(req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ errore: err.message });
  }
});

app.post('/api/channex/create-rate-plan', async (req, res) => {
  try {
    const data = await channex.client.createRatePlan(req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ errore: err.message });
  }
});

// ── Outbox: stato della coda ──────────────────────────────────
app.get('/api/channex/outbox', async (req, res) => {
  const { data, error } = await supabase
    .from('channex_outbox')
    .select('id, tipo, stato, tentativi, task_ids, errore, created_at, elaborato_at')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

// ── Log chiamate Channex ───────────────────────────────────────
app.get('/api/channex/log', async (req, res) => {
  const { data, error } = await supabase
    .from('channex_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

// ── Registra webhook su Channex ────────────────────────────────
app.post('/api/channex/setup-webhook', async (req, res) => {
  const webhookUrl = process.env.BASE_URL
    ? `${process.env.BASE_URL}/api/channex/webhook`
    : req.body.url;

  if (!webhookUrl) return res.status(400).json({ errore: 'Imposta BASE_URL nel .env o passa url nel body.' });

  try {
    const data = await channex.client.createWebhook({
      url: webhookUrl,
      is_active: true,
      send_data: true,
      event_mask: 'booking',
      // property_id: opzionale — se omesso, vale per tutte le property dell'account
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ errore: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// Avvio server
// ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Gestaway in ascolto sulla porta ${PORT}`);
  console.log(`Channex env: ${process.env.CHANNEX_ENV === 'production' ? 'PRODUZIONE' : 'STAGING'}`);
});

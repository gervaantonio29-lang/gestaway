// ============================================================
// GESTAWAY CONDOMINI — server.js
// Stack: Express + Supabase, mono-tenant (un amministratore)
// Stesse convenzioni di gestaway/cademaricomo (ADMIN_PASSWORD,
// cookie di sessione semplice, struttura API REST sotto /api)
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_COOKIE = 'gc_session';
// Token di sessione semplice, in memoria: sufficiente per mono-tenant
// (un solo amministratore). Si perde ai riavvii del server, in tal caso
// l'admin rifa' login: comportamento accettabile per questo caso d'uso.
const sessioniValide = new Set();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// ------------------------------------------------------------
// AUTH
// ------------------------------------------------------------
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
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ errore: 'ADMIN_PASSWORD non configurata sul server.' });
  }
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ errore: 'Password non corretta.' });
  }
  const token = generaToken();
  sessioniValide.add(token);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 giorni
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

// Tutte le rotte /api/* sotto questa riga richiedono login,
// tranne quelle di auth gia' dichiarate sopra.
app.use('/api', richiedeLogin);

// ------------------------------------------------------------
// CONDOMINI
// ------------------------------------------------------------
app.get('/api/condomini', async (req, res) => {
  const { data, error } = await supabase.from('condomini').select('*').order('created_at', { ascending: true });
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.post('/api/condomini', async (req, res) => {
  const { nome, indirizzo, codice_fiscale, iban } = req.body;
  if (!nome) return res.status(400).json({ errore: 'Il nome del condominio e\' obbligatorio.' });
  const { data, error } = await supabase
    .from('condomini')
    .insert({ nome, indirizzo, codice_fiscale, iban })
    .select()
    .single();
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.put('/api/condomini/:id', async (req, res) => {
  const { nome, indirizzo, codice_fiscale, iban } = req.body;
  const { data, error } = await supabase
    .from('condomini')
    .update({ nome, indirizzo, codice_fiscale, iban })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.delete('/api/condomini/:id', async (req, res) => {
  const { error } = await supabase.from('condomini').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ errore: error.message });
  res.json({ ok: true });
});

// ------------------------------------------------------------
// UNITA'
// ------------------------------------------------------------
app.get('/api/condomini/:condominioId/unita', async (req, res) => {
  const { data, error } = await supabase
    .from('unita')
    .select('*')
    .eq('condominio_id', req.params.condominioId)
    .order('interno', { ascending: true });
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.post('/api/condomini/:condominioId/unita', async (req, res) => {
  const { interno, piano, proprietario, email, telefono, millesimi, catasto_foglio, catasto_particella, catasto_subalterno } = req.body;
  if (!interno || !proprietario || millesimi == null) {
    return res.status(400).json({ errore: 'Interno, proprietario e millesimi sono obbligatori.' });
  }
  const { data, error } = await supabase
    .from('unita')
    .insert({
      condominio_id: req.params.condominioId,
      interno, piano: piano || null, proprietario, email, telefono,
      millesimi: Number(millesimi),
      catasto_foglio: catasto_foglio || null,
      catasto_particella: catasto_particella || null,
      catasto_subalterno: catasto_subalterno || null,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ errore: error.message });

  // Crea automaticamente il primo titolare (proprietario) cosi' l'unita'
  // ha sempre almeno una persona registrata nel registro anagrafe.
  await supabase.from('titolari').insert({
    unita_id: data.id, nome: proprietario, tipo: 'proprietario', email, telefono,
  });

  res.json(data);
});

app.put('/api/unita/:id', async (req, res) => {
  const { interno, piano, proprietario, email, telefono, millesimi, catasto_foglio, catasto_particella, catasto_subalterno } = req.body;
  const { data, error } = await supabase
    .from('unita')
    .update({
      interno, piano, proprietario, email, telefono, millesimi: Number(millesimi),
      catasto_foglio: catasto_foglio || null,
      catasto_particella: catasto_particella || null,
      catasto_subalterno: catasto_subalterno || null,
    })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.delete('/api/unita/:id', async (req, res) => {
  const { error } = await supabase.from('unita').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ errore: error.message });
  res.json({ ok: true });
});

// ------------------------------------------------------------
// TITOLARI — proprietari, nudi proprietari, usufruttuari, inquilini
// collegati a una stessa unita' (Registro di Anagrafe Condominiale)
// ------------------------------------------------------------
app.get('/api/unita/:unitaId/titolari', async (req, res) => {
  const { data, error } = await supabase
    .from('titolari')
    .select('*')
    .eq('unita_id', req.params.unitaId)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.post('/api/unita/:unitaId/titolari', async (req, res) => {
  const { nome, tipo, codice_fiscale, email, telefono, percentuale } = req.body;
  const tipiValidi = ['proprietario', 'nudo_proprietario', 'usufruttuario', 'inquilino'];
  if (!nome) return res.status(400).json({ errore: 'Il nome del titolare e\' obbligatorio.' });
  if (tipo && !tipiValidi.includes(tipo)) return res.status(400).json({ errore: 'Tipo titolare non valido.' });

  const { data, error } = await supabase
    .from('titolari')
    .insert({
      unita_id: req.params.unitaId,
      nome, tipo: tipo || 'proprietario',
      codice_fiscale: codice_fiscale || null,
      email: email || null, telefono: telefono || null,
      percentuale: percentuale != null ? Number(percentuale) : null,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.put('/api/titolari/:id', async (req, res) => {
  const { nome, tipo, codice_fiscale, email, telefono, percentuale } = req.body;
  const { data, error } = await supabase
    .from('titolari')
    .update({
      nome, tipo,
      codice_fiscale: codice_fiscale || null,
      email: email || null, telefono: telefono || null,
      percentuale: percentuale != null ? Number(percentuale) : null,
    })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.delete('/api/titolari/:id', async (req, res) => {
  const { error } = await supabase.from('titolari').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ errore: error.message });
  res.json({ ok: true });
});

// ------------------------------------------------------------
// SPESE — la creazione genera automaticamente le quote ripartite
// per millesimi su tutte le unita' del condominio.
// ------------------------------------------------------------
app.get('/api/condomini/:condominioId/spese', async (req, res) => {
  const { data, error } = await supabase
    .from('spese')
    .select('*')
    .eq('condominio_id', req.params.condominioId)
    .order('data', { ascending: false });
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.post('/api/condomini/:condominioId/spese', async (req, res) => {
  const condominioId = req.params.condominioId;
  const { categoria, importo, data: dataSpesa, fornitore, note, giorni_scadenza } = req.body;

  if (!categoria || !importo || !dataSpesa) {
    return res.status(400).json({ errore: 'Categoria, importo e data sono obbligatori.' });
  }

  const importoNum = Number(importo);
  const giorniScadenza = Number(giorni_scadenza) || 30;

  // 1. Recupera le unita' del condominio per calcolare la ripartizione
  const { data: unitaCondominio, error: erroreUnita } = await supabase
    .from('unita')
    .select('id, millesimi')
    .eq('condominio_id', condominioId);

  if (erroreUnita) return res.status(500).json({ errore: erroreUnita.message });
  if (!unitaCondominio || unitaCondominio.length === 0) {
    return res.status(400).json({ errore: 'Il condominio non ha unita\' immobiliari: impossibile ripartire la spesa.' });
  }

  // 2. Crea la spesa
  const { data: spesa, error: erroreSpesa } = await supabase
    .from('spese')
    .insert({
      condominio_id: condominioId,
      categoria, importo: importoNum, data: dataSpesa,
      fornitore: fornitore || null, note: note || null,
      giorni_scadenza: giorniScadenza,
    })
    .select()
    .single();

  if (erroreSpesa) return res.status(500).json({ errore: erroreSpesa.message });

  // 3. Calcola la scadenza
  const scadenza = new Date(dataSpesa);
  scadenza.setDate(scadenza.getDate() + giorniScadenza);
  const scadenzaStr = scadenza.toISOString().slice(0, 10);

  // 4. Genera una quota per ogni unita', proporzionale ai millesimi
  const quoteDaInserire = unitaCondominio.map(u => ({
    spesa_id: spesa.id,
    unita_id: u.id,
    condominio_id: condominioId,
    importo: Math.round((importoNum * Number(u.millesimi) / 1000) * 100) / 100,
    scadenza: scadenzaStr,
    stato: 'da_emettere',
  }));

  const { error: erroreQuote } = await supabase.from('quote').insert(quoteDaInserire);
  if (erroreQuote) {
    // Rollback manuale della spesa se le quote falliscono, per non lasciare dati orfani
    await supabase.from('spese').delete().eq('id', spesa.id);
    return res.status(500).json({ errore: 'Errore nella ripartizione: ' + erroreQuote.message });
  }

  res.json(spesa);
});

app.delete('/api/spese/:id', async (req, res) => {
  // Le quote collegate vengono eliminate automaticamente (on delete cascade)
  const { error } = await supabase.from('spese').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ errore: error.message });
  res.json({ ok: true });
});

// ------------------------------------------------------------
// QUOTE — scadenzario e aggiornamento stato pagamento
// ------------------------------------------------------------
app.get('/api/condomini/:condominioId/quote', async (req, res) => {
  const { stato } = req.query;
  let query = supabase
    .from('quote')
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
  const statiValidi = ['da_emettere', 'emesso', 'pagato', 'scaduto'];
  if (!statiValidi.includes(stato)) {
    return res.status(400).json({ errore: 'Stato non valido.' });
  }
  const aggiornamento = { stato };
  aggiornamento.data_pagamento = stato === 'pagato' ? new Date().toISOString().slice(0, 10) : null;

  const { data, error } = await supabase
    .from('quote')
    .update(aggiornamento)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

// ------------------------------------------------------------
// DASHBOARD — metriche aggregate per un condominio
// ------------------------------------------------------------
app.get('/api/condomini/:condominioId/dashboard', async (req, res) => {
  const condominioId = req.params.condominioId;

  const [{ data: spese, error: e1 }, { data: quote, error: e2 }, { data: unita, error: e3 }] = await Promise.all([
    supabase.from('spese').select('*').eq('condominio_id', condominioId),
    supabase.from('quote').select('*').eq('condominio_id', condominioId),
    supabase.from('unita').select('*').eq('condominio_id', condominioId),
  ]);

  if (e1 || e2 || e3) return res.status(500).json({ errore: (e1 || e2 || e3).message });

  const totSpesaAnno = spese.reduce((s, sp) => s + Number(sp.importo), 0);
  const totIncassato = quote.filter(q => q.stato === 'pagato').reduce((s, q) => s + Number(q.importo), 0);
  const totDaIncassare = quote.filter(q => q.stato !== 'pagato').reduce((s, q) => s + Number(q.importo), 0);
  const numScaduti = quote.filter(q => q.stato === 'scaduto').length;
  const totMillesimi = unita.reduce((s, u) => s + Number(u.millesimi), 0);

  const speseCategoria = {};
  spese.forEach(s => { speseCategoria[s.categoria] = (speseCategoria[s.categoria] || 0) + Number(s.importo); });

  res.json({
    totSpesaAnno, totIncassato, totDaIncassare, numScaduti, totMillesimi,
    numUnita: unita.length,
    speseCategoria: Object.entries(speseCategoria).map(([categoria, importo]) => ({ categoria, importo })),
  });
});

// ------------------------------------------------------------
// Avvio server
// ------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Gestaway Condomini in ascolto sulla porta ${PORT}`);
});

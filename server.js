const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const ws = require('ws');
const { createChannexServices } = require('./channex');

// ─── CRASH PREVENTION ─────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('❌ Errore non gestito (uncaughtException):', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ Promise non gestita (unhandledRejection):', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase
const supabase = createClient(
  process.env.DB_URL || process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || '',
  { realtime: { transport: ws } }
);

// Password admin
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const crypto = require('crypto');
const STATIC_TOKEN = crypto.createHash('sha256').update('gestionale-' + ADMIN_PASSWORD + '-token').digest('hex');

app.use(cors());
app.use(express.json());

// ─── Channex services ─────────────────────────────────────────────────────────
const channex = createChannexServices(supabase);

if (process.env.CHANNEX_API_KEY) {
  channex.bookings.startPolling();
} else {
  console.warn('[Channex] CHANNEX_API_KEY non impostata — polling disabilitato');
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token || token !== STATIC_TOKEN) return res.status(401).json({ error: 'Non autorizzato' });
  next();
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ ok: true, token: STATIC_TOKEN });
  } else {
    res.status(401).json({ error: 'Password errata' });
  }
});

app.post('/api/logout', (req, res) => {
  res.json({ ok: true });
});

// ─── WEBHOOK CHANNEX (no auth — Channex chiama direttamente) ──────────────────
app.post('/api/channex/webhook', express.json(), async (req, res) => {
  try {
    const payload = req.body;
    const event = payload?.event || payload?.type;
    await supabase.from('channex_log').insert({
      tipo: 'webhook', dettagli: payload, esito: 'ok',
      messaggio: `Webhook ricevuto: ${event}`,
    }).catch(() => {});
    if (event === 'booking' || event === 'BookingRevision' || payload?.booking_id) {
      channex.bookings.poll().catch(err =>
        console.error('[Webhook] Errore poll:', err.message)
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ errore: err.message });
  }
});

// ─── CHECK-IN PUBBLICO (no auth) ──────────────────────────────────────────────
app.get('/api/checkin/cerca', async (req, res) => {
  const { nome, data, orario } = req.query;
  if (!nome || !data) return res.status(400).json({ error: 'Parametri mancanti' });
  const { data: prens } = await supabase
    .from('prenotazioni')
    .select('id, data_arrivo, data_partenza, ospite, appartamenti(nome)')
    .eq('data_arrivo', data);
  if (!prens || !prens.length) return res.status(404).json({ error: 'Non trovata' });
  const nomeQuery = nome.toLowerCase().trim();
  const pren = prens.find(p => {
    const ospite = (p.ospite || '').toLowerCase();
    return ospite.includes(nomeQuery) || nomeQuery.split(' ').some(part => part.length > 2 && ospite.includes(part));
  });
  if (!pren) return res.status(404).json({ error: 'Non trovata' });
  if (orario) {
    await supabase.from('prenotazioni').update({ orario_arrivo: orario }).eq('id', pren.id);
  }
  res.json({ ...pren, appartamento_nome: pren.appartamenti?.nome || '—' });
});

app.get('/api/checkin/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('prenotazioni')
    .select('id, data_arrivo, data_partenza, ospite, appartamenti(nome)')
    .eq('id', req.params.id)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Non trovata' });
  res.json({ ...data, appartamento_nome: data.appartamenti?.nome || '—' });
});

app.get('/api/checkin/:id/ospiti', async (req, res) => {
  const { data, error } = await supabase.from('ospiti').select('*').eq('prenotazione_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/checkin/:id/ospiti', async (req, res) => {
  const { data, error } = await supabase
    .from('ospiti')
    .insert({ ...req.body, prenotazione_id: parseInt(req.params.id) })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ id: data.id });
});

app.delete('/api/checkin/ospiti/:id', async (req, res) => {
  const { error } = await supabase.from('ospiti').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.post('/api/checkin/:id/conferma', async (req, res) => {
  const { error } = await supabase
    .from('prenotazioni')
    .update({ checkin_completato: true })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── CALENDARIO PUBBLICO ───────────────────────────────────────────────────────
app.get('/api/disponibilita/:nomeAppartamento', async (req, res) => {
  const nome = req.params.nomeAppartamento;
  const { data: apt } = await supabase
    .from('appartamenti')
    .select('id, prezzo_base, iva_percent, markup_sito, rincaro_bassa, rincaro_media, rincaro_alta')
    .ilike('nome', nome)
    .single();
  if (!apt) return res.status(404).json({ error: 'Appartamento non trovato' });
  const oggi = new Date();
  const y = oggi.getFullYear();
  const m = String(oggi.getMonth() + 1).padStart(2, '0');
  const inizioMese = `${y}-${m}-01`;
  const fine = new Date(y, oggi.getMonth() + 3, 0);
  const fineMese = `${fine.getFullYear()}-${String(fine.getMonth()+1).padStart(2,'0')}-${String(fine.getDate()).padStart(2,'0')}`;
  const { data: prens } = await supabase
    .from('prenotazioni')
    .select('data_arrivo, data_partenza')
    .eq('appartamento_id', apt.id)
    .neq('stato', 'cancellata')
    .gte('data_partenza', inizioMese)
    .lte('data_arrivo', fineMese);
  const prezzi = {};
  if (apt.prezzo_base) {
    const base = apt.prezzo_base;
    const iva = (apt.iva_percent || 0) / 100;
    const sito = (apt.markup_sito || 0) / 100;
    const baseConIva = base * (1 + iva);
    prezzi.bassa = +(baseConIva * (1 + sito) * (1 + (apt.rincaro_bassa || 0) / 100)).toFixed(2);
    prezzi.media = +(baseConIva * (1 + sito) * (1 + (apt.rincaro_media || 0) / 100)).toFixed(2);
    prezzi.alta  = +(baseConIva * (1 + sito) * (1 + (apt.rincaro_alta  || 0) / 100)).toFixed(2);
  }
  res.json({ prenotazioni: prens || [], prezzi });
});

// ─── RICHIESTA DAL SITO ───────────────────────────────────────────────────────
app.post('/api/richiesta', async (req, res) => {
  const { nome, email, data_arrivo, data_partenza, ospiti, messaggio } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome mancante' });
  const uid = 'richiesta_' + Date.now();
  const { error } = await supabase.from('prenotazioni').insert({
    uid, ospite: nome, email_ospite: email,
    data_arrivo: data_arrivo || null,
    data_partenza: data_partenza || null,
    stato: 'richiesta', fonte: 'sito',
    note: `Ospiti: ${ospiti || '—'}\n${messaggio || ''}`.trim(),
    questura_inviata: 0
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── STATIC ───────────────────────────────────────────────────────────────────
app.get('/gestionale', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'gestionale.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── APPARTAMENTI ─────────────────────────────────────────────────────────────
app.get('/api/appartamenti', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('appartamenti').select('*').order('id');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/appartamenti', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('appartamenti').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ id: data.id });
});

app.put('/api/appartamenti/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('appartamenti').update(req.body).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete('/api/appartamenti/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('appartamenti').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── PRENOTAZIONI ─────────────────────────────────────────────────────────────
app.get('/api/prenotazioni', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('prenotazioni')
    .select('*, appartamenti(nome)')
    .order('data_arrivo', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const result = data.map(p => ({ ...p, appartamento_nome: p.appartamenti?.nome || '—' }));
  res.json(result);
});

app.post('/api/prenotazioni', requireAuth, async (req, res) => {
  const uid = 'manual_' + Date.now();
  const { data, error } = await supabase.from('prenotazioni').insert({ ...req.body, uid, stato: 'confermata', questura_inviata: 0 }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ id: data.id });
});

app.put('/api/prenotazioni/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('prenotazioni').update(req.body).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete('/api/prenotazioni/:id', requireAuth, async (req, res) => {
  await supabase.from('ospiti').delete().eq('prenotazione_id', req.params.id);
  const { error } = await supabase.from('prenotazioni').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── OSPITI ───────────────────────────────────────────────────────────────────
app.get('/api/prenotazioni/:id/ospiti', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('ospiti').select('*').eq('prenotazione_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/prenotazioni/:id/ospiti', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('ospiti').insert({ ...req.body, prenotazione_id: parseInt(req.params.id) }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ id: data.id });
});

app.delete('/api/ospiti/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('ospiti').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── IMPOSTAZIONI ─────────────────────────────────────────────────────────────
app.get('/api/impostazioni', requireAuth, async (req, res) => {
  const { data } = await supabase.from('impostazioni').select('*');
  const cfg = {};
  (data || []).forEach(r => cfg[r.chiave] = r.valore);
  ['email_pass', 'switchbot_secret', 'alloggiati_pass'].forEach(k => { if (cfg[k]) cfg[k] = '••••••••'; });
  res.json(cfg);
});

app.post('/api/impostazioni', requireAuth, async (req, res) => {
  for (const [k, v] of Object.entries(req.body)) {
    if (v !== '••••••••') {
      await supabase.from('impostazioni').upsert({ chiave: k, valore: v });
    }
  }
  res.json({ ok: true });
});

// ─── STATS ────────────────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, async (req, res) => {
  const oggi = new Date();
  const y = oggi.getFullYear(), mo = String(oggi.getMonth()+1).padStart(2,'0'), d = String(oggi.getDate()).padStart(2,'0');
  const oggiStr = `${y}-${mo}-${d}`;
  const { data: apts } = await supabase.from('appartamenti').select('id');
  const { data: prens } = await supabase.from('prenotazioni').select('*').neq('stato', 'cancellata');
  const totApt = (apts || []).length;
  const totPren = (prens || []).length;
  const inCasa = (prens || []).filter(p => p.data_arrivo <= oggiStr && p.data_partenza > oggiStr).length;
  const questuraDa = (prens || []).filter(p => !p.questura_inviata && p.data_arrivo <= oggiStr).length;
  const { data: apts2 } = await supabase.from('appartamenti').select('nome,id');
  const aptsMap = {};
  (apts2 || []).forEach(a => aptsMap[a.id] = a.nome);
  const prossimi = (prens || []).filter(p => p.data_arrivo > oggiStr).sort((a,b) => a.data_arrivo > b.data_arrivo ? 1 : -1).slice(0, 5).map(p => ({ ...p, apt: aptsMap[p.appartamento_id] || '—' }));
  res.json({ totApt, totPren, inCasa, questuraDa, prossimi });
});

// ─── SYNC ICAL ────────────────────────────────────────────────────────────────
function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Troppi redirect'));
    const client = url.startsWith('https') ? https : require('http');
    client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GestionaleSync/1.0)' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        const nextUrl = r.headers.location.startsWith('http') ? r.headers.location : new URL(r.headers.location, url).href;
        r.resume();
        return resolve(fetchUrl(nextUrl, redirectCount + 1));
      }
      if (r.statusCode >= 400) { r.resume(); return reject(new Error(`HTTP ${r.statusCode} su ${url}`)); }
      let data = '';
      r.on('data', chunk => data += chunk);
      r.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseIcal(data, fonte, appartamento_id) {
  const events = [];
  const blocks = data.split('BEGIN:VEVENT');
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const get = (key) => { const m = block.match(new RegExp(key + '[^:]*:([^\\r\\n]+)')); return m ? m[1].trim() : ''; };
    const uid = get('UID'); const summary = get('SUMMARY'); const dtstart = get('DTSTART'); const dtend = get('DTEND');
    if (!uid || !dtstart || !dtend) continue;
    const parseDate = (d) => d.replace(/[TZ]/g, '').replace(/(\d{4})(\d{2})(\d{2}).*/, '$1-$2-$3');
    events.push({ uid: uid + '_' + fonte, ospite: summary || 'Ospite', data_arrivo: parseDate(dtstart), data_partenza: parseDate(dtend), fonte, appartamento_id });
  }
  return events;
}

app.post('/api/sync/:id', requireAuth, async (req, res) => {
  const { data: apt } = await supabase.from('appartamenti').select('*').eq('id', req.params.id).single();
  if (!apt) return res.status(404).json({ error: 'Non trovato' });
  let importati = 0;
  const dettagli = [];
  for (const [url, fonte] of [[apt.ical_airbnb, 'Airbnb'], [apt.ical_booking, 'Booking']]) {
    if (!url) { dettagli.push({ fonte, stato: 'saltato', motivo: 'URL non configurato' }); continue; }
    try {
      const data = await fetchUrl(url);
      const eventi = parseIcal(data, fonte, apt.id);
      let importatiFonte = 0;
      for (const e of eventi) {
        if (fonte === 'Airbnb') {
          const n = (e.ospite || '').toUpperCase();
          if (n.includes('NOT AVAILABLE') || n === 'CLOSED' || n === 'BLOCKED') continue;
        }
        const { error } = await supabase.from('prenotazioni').upsert({ ...e, stato: 'confermata', questura_inviata: 0 }, { onConflict: 'uid' });
        if (!error) { importati++; importatiFonte++; }
        else console.error(`Errore upsert ${fonte}:`, error.message);
      }
      dettagli.push({ fonte, stato: 'ok', eventiNelFeed: eventi.length, importati: importatiFonte });
    } catch (e) {
      console.error('Errore iCal ' + fonte, e.message);
      dettagli.push({ fonte, stato: 'errore', motivo: e.message });
    }
  }
  res.json({ ok: true, importati, dettagli });
});

// ─── PULIZIA ─────────────────────────────────────────────────────────────────
app.post('/api/pulizia/not-available', requireAuth, async (req, res) => {
  const { data: prens } = await supabase.from('prenotazioni').select('id, ospite, fonte').eq('fonte', 'Airbnb');
  let rimossi = 0;
  for (const p of (prens || [])) {
    const n = (p.ospite || '').toUpperCase();
    if (n.includes('NOT AVAILABLE') || n === 'CLOSED' || n === 'BLOCKED') {
      await supabase.from('prenotazioni').delete().eq('id', p.id);
      rimossi++;
    }
  }
  res.json({ ok: true, rimossi });
});

// ─── EMAIL ────────────────────────────────────────────────────────────────────
async function getEmailConfig() {
  const { data } = await supabase.from('impostazioni').select('*').in('chiave', ['email_user', 'email_pass']);
  const cfg = {};
  (data || []).forEach(r => cfg[r.chiave] = r.valore);
  return cfg.email_user && cfg.email_pass ? cfg : null;
}

app.post('/api/email/test', requireAuth, async (req, res) => {
  try {
    const cfg = await getEmailConfig();
    if (!cfg) return res.status(400).json({ error: 'Email non configurata' });
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: cfg.email_user, pass: cfg.email_pass } });
    await transporter.sendMail({ from: cfg.email_user, to: cfg.email_user, subject: 'Test gestionale', text: 'Funziona!' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function parseDataEmail(giorno, mese, anno) {
  const mesiEn = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  const mesiIt = { gen:1,feb:2,mar:3,apr:4,mag:5,giu:6,lug:7,ago:8,set:9,ott:10,nov:11,dic:12 };
  const meseN = mesiEn[mese.toLowerCase()] || mesiIt[mese.toLowerCase()] || parseInt(mese);
  if (!meseN) return null;
  return `${anno}-${String(meseN).padStart(2,'0')}-${String(giorno).padStart(2,'0')}`;
}

app.post('/api/email/leggi-airbnb', requireAuth, async (req, res) => {
  try {
    const cfg = await getEmailConfig();
    if (!cfg) return res.status(400).json({ error: 'Email non configurata' });
    const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: cfg.email_user, pass: cfg.email_pass }, logger: false });
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    const aggiornati = [];
    try {
      const { data: prens } = await supabase.from('prenotazioni').select('*');
      const airbnbMessages = await client.search({ from: 'airbnb.com' });
      for (const uid of airbnbMessages.slice(-200)) {
        const msg = await client.fetchOne(uid, { source: true });
        const parsed = await simpleParser(msg.source);
        const testo = ((parsed.text || '') + ' ' + (parsed.html || '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        let nome = null, checkin = null, guadagni = null;
        const nomeMatch = testo.match(/([A-Za-zàèéìòùÀÈÉÌÒÙ]+ [A-Za-zàèéìòùÀÈÉÌÒÙ]+) ha prenotato/i) || testo.match(/Reservation from ([A-Za-z]+ [A-Za-z]+)/i);
        if (nomeMatch) nome = nomeMatch[1].trim();
        const guadagniMatch = testo.match(/Guadagni.*?€\s*([\d.,]+)/i) || testo.match(/You earn.*?\$\s*([\d.,]+)/i);
        if (guadagniMatch) guadagni = parseFloat(guadagniMatch[1].replace(',', '.'));
        const checkinMatch = testo.match(/Check-in[:\s]+([a-z]{3})\s+(\d{1,2}),?\s+(\d{4})/i);
        if (checkinMatch) checkin = parseDataEmail(checkinMatch[2], checkinMatch[1], checkinMatch[3]);
        if (!nome && !guadagni) continue;
        let pren = null;
        if (checkin) pren = (prens || []).find(p => p.fonte === 'Airbnb' && p.data_arrivo === checkin);
        if (!pren && nome) pren = (prens || []).find(p => p.fonte === 'Airbnb' && (p.ospite === 'Reserved' || p.ospite?.includes('Not available')));
        if (pren) {
          const update = {};
          if (nome) update.ospite = nome;
          if (guadagni) update.importo = guadagni;
          await supabase.from('prenotazioni').update(update).eq('id', pren.id);
          aggiornati.push({ id: pren.id, nome, guadagni });
        }
      }
      const lodgifyMessages = await client.search({ from: 'messaging.lodgify.com' });
      for (const uid of lodgifyMessages.slice(-200)) {
        const msg = await client.fetchOne(uid, { source: true });
        const parsed = await simpleParser(msg.source);
        const testoL = ((parsed.text || '') + ' ' + (parsed.html || '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        if (!testoL.toLowerCase().includes('prenotazione') || testoL.toLowerCase().includes('rifiutata')) continue;
        let nome = null, checkin = null, guadagni = null, emailOspite = null;
        const subjectNome = (parsed.subject || '').match(/confermata:\s*([A-Za-zàèéìòùÀÈÉÌÒÙ ]+?)\s*\(/i);
        if (subjectNome) nome = subjectNome[1].trim();
        if (!nome) { const m = testoL.match(/Nome:\s*([A-Za-zàèéìòùÀÈÉÌÒÙ]+ [A-Za-zàèéìòùÀÈÉÌÒÙ]+)/i); if (m) nome = m[1].trim(); }
        const subjectArrivo = (parsed.subject || '').match(/[Aa]rrivo:\s*([a-z]{3})\s+(\d{1,2})\s+(\d{4})/i);
        if (subjectArrivo) checkin = parseDataEmail(subjectArrivo[2], subjectArrivo[1], subjectArrivo[3]);
        if (!checkin) { const m = testoL.match(/Arrivo:\s*([a-z]{3})\s+(\d{1,2})\s+(\d{4})/i); if (m) checkin = parseDataEmail(m[2], m[1], m[3]); }
        const totaleMatch = testoL.match(/Totale Prenotazione:\s*EUR\s*([\d]+[.,][\d]+)/i);
        if (totaleMatch) guadagni = parseFloat(totaleMatch[1].replace(',', '.'));
        const emailMatch = testoL.match(/Email:\s*([\w.+%-]+@[\w.-]+\.[a-z]{2,})/i);
        if (emailMatch) emailOspite = emailMatch[1].trim();
        if (!nome && !checkin) continue;
        let pren = null;
        if (checkin) pren = (prens || []).find(p => p.data_arrivo === checkin);
        if (!pren && nome) pren = (prens || []).find(p => p.ospite === 'CLOSED - Not available' || p.ospite?.includes('Not available') || p.ospite === 'Reserved');
        if (pren) {
          const update = {};
          if (nome) update.ospite = nome;
          if (guadagni) update.importo = guadagni;
          if (emailOspite) update.email_ospite = emailOspite;
          await supabase.from('prenotazioni').update(update).eq('id', pren.id);
          aggiornati.push({ id: pren.id, nome, guadagni, fonte: 'Lodgify' });
        }
      }
    } finally { lock.release(); }
    await client.logout();
    res.json({ ok: true, aggiornati: aggiornati.length, dettagli: aggiornati });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── QUESTURA ─────────────────────────────────────────────────────────────────
function buildAlloggiatiLines(ospiti, pren) {
  function pad(str, len) { return String(str || '').substring(0, len).padEnd(len, ' '); }
  function formatData(d) {
    if (!d) return '          ';
    if (d.includes('/')) return d.padEnd(10, ' ');
    const parts = d.split('-');
    if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
    return '          ';
  }
  return ospiti.map((o, i) => {
    const tipoAlloggiato = i === 0 ? '16' : '19';
    const dataArrivo = formatData(pren.data_arrivo);
    const giorniPermanenza = (() => { if (!pren.data_arrivo || !pren.data_partenza) return ' 1'; const diff = Math.round((new Date(pren.data_partenza) - new Date(pren.data_arrivo)) / 86400000); return String(diff).padStart(2, ' '); })();
    const cognome = pad(o.cognome, 50); const nome = pad(o.nome, 30); const sesso = String(o.sesso || '1');
    const dataNascita = formatData(o.data_nascita);
    const statoCodice = pad(o.stato_nascita_codice || '100000100', 9);
    const comuneCodice = o.comune_nascita_codice ? pad(o.comune_nascita_codice, 9) : '         ';
    const provincia = o.comune_nascita_provincia ? pad(o.comune_nascita_provincia, 2) : '  ';
    let riga = tipoAlloggiato + dataArrivo + giorniPermanenza + cognome + nome + sesso + dataNascita + comuneCodice + provincia + statoCodice + statoCodice;
    if (i === 0) { const tipoDoc = pad(o.tipo_documento || 'IDENT', 5); const numDoc = pad(o.numero_documento, 20); const luogoRilascio = o.comune_nascita_codice ? pad(o.comune_nascita_codice, 9) : pad(statoCodice, 9); riga += tipoDoc + numDoc + luogoRilascio; }
    else { riga += ' '.repeat(34); }
    return riga;
  });
}

function soapRequest(action, body) {
  return new Promise((resolve, reject) => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:all="AlloggiatiService">\n  <soap:Header/>\n  <soap:Body>${body}</soap:Body>\n</soap:Envelope>`;
    const options = { hostname: 'alloggiatiweb.poliziadistato.it', path: '/service/Service.asmx', method: 'POST', headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(xml, 'utf8') } };
    const req = https.request(options, (r) => { let data = ''; r.on('data', chunk => data += chunk); r.on('end', () => resolve(data)); });
    req.on('error', reject); req.write(xml); req.end();
  });
}

function extractXmlTag(xml, tag) { const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`)); return m ? m[1].trim() : null; }

async function generaTokenAW(utente, password, wsKey) {
  const body = `<all:GenerateToken>\n    <all:Utente>${utente}</all:Utente>\n    <all:Password>${password}</all:Password>\n    <all:WsKey>${wsKey}</all:WsKey>\n  </all:GenerateToken>`;
  const risposta = await soapRequest('GenerateToken', body);
  const token = extractXmlTag(risposta, 'token');
  if (!token) throw new Error('Token non ricevuto: ' + risposta.substring(0, 200));
  return token;
}

async function inviaSchedeAW(utente, token, lines) {
  const righe = lines.map(r => `    <all:string>${r}</all:string>`).join('\n');
  const body = `<all:Send xmlns:all="AlloggiatiService">\n    <all:Utente>${utente}</all:Utente>\n    <all:token>${token}</all:token>\n    <all:ElencoSchedine>\n${righe}\n    </all:ElencoSchedine>\n  </all:Send>`;
  const risposta = await soapRequest('Send', body);
  return { esito: extractXmlTag(risposta, 'esito'), errore: extractXmlTag(risposta, 'ErroreDettaglio'), schedineValide: extractXmlTag(risposta, 'SchedineValide') };
}

app.post('/api/questura/invia', requireAuth, async (req, res) => {
  const { data: pren } = await supabase.from('prenotazioni').select('*').eq('id', req.body.prenotazione_id).single();
  const { data: ospiti } = await supabase.from('ospiti').select('*').eq('prenotazione_id', req.body.prenotazione_id);
  if (!pren || !ospiti?.length) return res.status(400).json({ error: 'Prenotazione o ospiti mancanti' });
  const lines = buildAlloggiatiLines(ospiti, pren);
  const contenuto = lines.join('\r\n');
  const { data: cfgData } = await supabase.from('impostazioni').select('*').in('chiave', ['alloggiati_user', 'alloggiati_pass', 'alloggiati_ws']);
  const cfg = {}; (cfgData || []).forEach(r => cfg[r.chiave] = r.valore);
  if (cfg.alloggiati_user && cfg.alloggiati_pass && cfg.alloggiati_ws) {
    try {
      const token = await generaTokenAW(cfg.alloggiati_user, cfg.alloggiati_pass, cfg.alloggiati_ws);
      const { esito, errore, schedineValide } = await inviaSchedeAW(cfg.alloggiati_user, token, lines);
      if (esito === 'true' || (schedineValide && parseInt(schedineValide) > 0)) {
        await supabase.from('prenotazioni').update({ questura_inviata: 1 }).eq('id', req.body.prenotazione_id);
        return res.json({ ok: true, inviato_automaticamente: true, contenuto });
      } else {
        return res.json({ ok: true, inviato_automaticamente: false, errore_invio: errore || 'Errore sconosciuto', contenuto });
      }
    } catch (e) { return res.json({ ok: true, inviato_automaticamente: false, errore_invio: e.message, contenuto }); }
  }
  await supabase.from('prenotazioni').update({ questura_inviata: 1 }).eq('id', req.body.prenotazione_id);
  res.json({ ok: true, inviato_automaticamente: false, contenuto });
});

// ─── ROSS1000 ─────────────────────────────────────────────────────────────────
function fmtData(d) {
  const date = new Date(d);
  const y = date.getFullYear();
  const m = String(date.getMonth()+1).padStart(2,'0');
  const day = String(date.getDate()).padStart(2,'0');
  return `${y}${m}${day}`;
}

function buildRoss1000XML(codice, prenotazioni, ospiti) {
  const byDate = {};
  for (const p of prenotazioni) {
    const dateKey = p.data_arrivo;
    if (!byDate[dateKey]) byDate[dateKey] = { prenotazione: p, ospiti: [] };
  }
  for (const o of ospiti) {
    const p = prenotazioni.find(p => p.id === o.prenotazione_id);
    if (p && byDate[p.data_arrivo]) byDate[p.data_arrivo].ospiti.push(o);
  }
  let movimenti = '';
  for (const [data, { prenotazione: pren, ospiti: osps }] of Object.entries(byDate).sort()) {
    const dataFmt = fmtData(data);
    let arrivi = '';
    for (const o of osps) {
      const isCapo = osps.indexOf(o) === 0;
      const idswh = `${pren.id}-${o.id}`.substring(0, 20);
      const idcapo = isCapo ? '' : `${pren.id}-${osps[0].id}`.substring(0, 20);
      const tipoAlloggiato = isCapo ? '16' : '19';
      const nascita = o.data_nascita ? fmtData(o.data_nascita) : '19800101';
      const cittadinanza = o.nazionalita === 'ITA' || !o.nazionalita ? '100000100' : '100000200';
      const canale = pren.canale === 'Airbnb' ? 'Indiretta web' : pren.canale === 'Booking' ? 'Indiretta web' : 'Diretta web';
      arrivi += `<arrivo><idswh>${idswh}</idswh><tipoalloggiato>${tipoAlloggiato}</tipoalloggiato><idcapo>${idcapo}</idcapo><sesso>${o.sesso || 'M'}</sesso><cittadinanza>${cittadinanza}</cittadinanza><statoresidenza>${cittadinanza}</statoresidenza><luogoresidenza>${o.luogo_nascita || ''}</luogoresidenza><datanascita>${nascita}</datanascita><statonascita>${cittadinanza}</statonascita><comunenascita></comunenascita><tipoturismo>Escursionistico/Naturalistico</tipoturismo><mezzotrasporto>Auto</mezzotrasporto><canaleprenotazione>${canale}</canaleprenotazione><titolostudio></titolostudio><professione></professione><esenzioneimposta></esenzioneimposta></arrivo>`;
    }
    let partenze = '';
    for (const o of osps) {
      const idswh = `${pren.id}-${o.id}`.substring(0, 20);
      const tipoAlloggiato = osps.indexOf(o) === 0 ? '16' : '19';
      partenze += `<partenza><idswh>${idswh}</idswh><tipoalloggiato>${tipoAlloggiato}</tipoalloggiato><arrivo>${dataFmt}</arrivo></partenza>`;
    }
    movimenti += `<movimento><data>${dataFmt}</data><struttura><apertura>SI</apertura><camereoccupate>1</camereoccupate><cameredisponibili>1</cameredisponibili><lettidisponibili>2</lettidisponibili></struttura>${arrivi ? `<arrivi>${arrivi}</arrivi>` : ''}${partenze ? `<partenze>${partenze}</partenze>` : ''}</movimento>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?><movimenti><codice>${codice}</codice><prodotto>GestionaleAppartamenti</prodotto>${movimenti}</movimenti>`;
}

app.get('/api/ross1000/genera-xml', requireAuth, async (req, res) => {
  try {
    const { mese, anno } = req.query;
    const meseN = parseInt(mese) || new Date().getMonth() + 1;
    const annoN = parseInt(anno) || new Date().getFullYear();
    const { data: cfg } = await supabase.from('impostazioni').select('*').in('chiave', ['ross1000_codice', 'ross1000_user', 'ross1000_pass']);
    const impost = {}; (cfg || []).forEach(r => impost[r.chiave] = r.valore);
    if (!impost.ross1000_codice) return res.status(400).json({ error: 'Codice Ross1000 non configurato' });
    const dataInizio = `${annoN}-${String(meseN).padStart(2,'0')}-01`;
    const dataFine = `${annoN}-${String(meseN).padStart(2,'0')}-31`;
    const { data: prens } = await supabase.from('prenotazioni').select('*').gte('data_arrivo', dataInizio).lte('data_arrivo', dataFine).neq('stato', 'cancellata');
    const prenIds = (prens || []).map(p => p.id);
    const { data: ospiti } = prenIds.length ? await supabase.from('ospiti').select('*').in('prenotazione_id', prenIds) : { data: [] };
    const xml = buildRoss1000XML(impost.ross1000_codice, prens || [], ospiti || []);
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="ross1000_${annoN}${String(meseN).padStart(2,'0')}.xml"`);
    res.send(xml);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── CHANNEX API ──────────────────────────────────────────────────────────────
app.get('/api/channex/mappings', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('channex_mappings').select('*, channex_room_mappings(*), channex_rate_mappings(*)').order('created_at');
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.post('/api/channex/mappings', requireAuth, async (req, res) => {
  const { gestaway_property_id, gestaway_nome, channex_property_id } = req.body;
  if (!gestaway_property_id || !channex_property_id) return res.status(400).json({ errore: 'Campi obbligatori mancanti.' });
  const { data, error } = await supabase.from('channex_mappings').upsert(
    { gestaway_property_id, gestaway_nome: gestaway_nome || gestaway_property_id, channex_property_id },
    { onConflict: 'gestaway_property_id' }
  ).select().single();
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.post('/api/channex/room-mappings', requireAuth, async (req, res) => {
  const { gestaway_property_id, gestaway_room_id, gestaway_room_nome, channex_room_type_id, channex_room_type_nome, disponibilita_default } = req.body;
  if (!gestaway_property_id || !gestaway_room_id || !channex_room_type_id) return res.status(400).json({ errore: 'Campi obbligatori mancanti.' });
  const { data, error } = await supabase.from('channex_room_mappings').upsert({
    gestaway_property_id, gestaway_room_id, gestaway_room_nome: gestaway_room_nome || gestaway_room_id,
    channex_room_type_id, channex_room_type_nome: channex_room_type_nome || '', disponibilita_default: disponibilita_default ?? 1,
  }, { onConflict: 'gestaway_room_id' }).select().single();
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.post('/api/channex/rate-mappings', requireAuth, async (req, res) => {
  const { gestaway_property_id, gestaway_room_id, channex_room_type_id, channex_rate_plan_id, channex_rate_plan_nome, prezzo_default, min_stay_default, valuta } = req.body;
  if (!gestaway_property_id || !channex_rate_plan_id) return res.status(400).json({ errore: 'Campi obbligatori mancanti.' });
  const { data, error } = await supabase.from('channex_rate_mappings').upsert({
    gestaway_property_id, gestaway_room_id: gestaway_room_id || null, channex_room_type_id: channex_room_type_id || null,
    channex_rate_plan_id, channex_rate_plan_nome: channex_rate_plan_nome || '',
    prezzo_default: prezzo_default ?? 100, min_stay_default: min_stay_default ?? 1, valuta: valuta || 'EUR',
  }, { onConflict: 'channex_rate_plan_id' }).select().single();
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.get('/api/channex/properties', requireAuth, async (req, res) => {
  try { res.json(await channex.client.listProperties()); }
  catch (err) { res.status(500).json({ errore: err.message }); }
});

app.get('/api/channex/room-types/:propertyId', requireAuth, async (req, res) => {
  try { res.json(await channex.client.listRoomTypes(req.params.propertyId)); }
  catch (err) { res.status(500).json({ errore: err.message }); }
});

app.get('/api/channex/rate-plans/:propertyId', requireAuth, async (req, res) => {
  try { res.json(await channex.client.listRatePlans(req.params.propertyId)); }
  catch (err) { res.status(500).json({ errore: err.message }); }
});

app.post('/api/channex/full-sync/:propertyId', requireAuth, async (req, res) => {
  try { await channex.sync.fullSync(req.params.propertyId); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ errore: err.message }); }
});

app.post('/api/channex/push-ari/:propertyId', requireAuth, async (req, res) => {
  const { tipo, values } = req.body;
  if (!tipo || !values?.length) return res.status(400).json({ errore: 'tipo e values[] obbligatori.' });
  try {
    await channex.outbox.enqueue(tipo, { values }, req.params.propertyId);
    await channex.outbox.flush();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ errore: err.message }); }
});

app.get('/api/channex/prenotazioni', requireAuth, async (req, res) => {
  const { property_id, stato, limit = 50 } = req.query;
  let query = supabase.from('channex_prenotazioni').select('*').order('arrivo', { ascending: false }).limit(Number(limit));
  if (property_id) query = query.eq('gestaway_property_id', property_id);
  if (stato) query = query.eq('stato', stato);
  const { data, error } = await query;
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

app.post('/api/channex/poll-bookings', requireAuth, async (req, res) => {
  try { await channex.bookings.poll(); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ errore: err.message }); }
});

app.post('/api/channex/setup-webhook', requireAuth, async (req, res) => {
  const webhookUrl = process.env.BASE_URL ? `${process.env.BASE_URL}/api/channex/webhook` : req.body.url;
  if (!webhookUrl) return res.status(400).json({ errore: 'Imposta BASE_URL.' });
  const propertyId = req.body.property_id || null;
  try {
    res.json(await channex.client.createWebhook({ 
      url: webhookUrl, 
      is_active: true, 
      send_data: true, 
      event_mask: 'booking',
      property_id: propertyId
    }));
  } catch (err) { res.status(500).json({ errore: err.message }); }
});

app.get('/api/channex/outbox', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('channex_outbox')
    .select('id, tipo, stato, tentativi, task_ids, errore, created_at, elaborato_at')
    .order('created_at', { ascending: false }).limit(100);
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});

// ─── AVVIO ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => { console.log(`\n✅ Gestionale avviato su porta ${PORT}!\n`); });

// ─── JOB AUTOMATICI ───────────────────────────────────────────────────────────
async function leggiEmailAuto() {
  console.log('📧 [AUTO] Lettura email in corso...');
  try {
    const { data: cfgData } = await supabase.from('impostazioni').select('*').in('chiave', ['email_user', 'email_pass']);
    const cfg = {}; (cfgData || []).forEach(r => cfg[r.chiave] = r.valore);
    if (!cfg.email_user || !cfg.email_pass) { console.log('📧 [AUTO] Email non configurata, skip.'); return; }
    const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: cfg.email_user, pass: cfg.email_pass }, logger: false });
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      let count = 0;
      for await (const msg of client.fetch({ since: new Date(Date.now() - 48 * 60 * 60 * 1000) }, { source: true })) { count++; }
      console.log('📧 [AUTO] Email lette:', count);
    } finally { lock.release(); }
    await client.logout();
  } catch(e) { console.error('📧 [AUTO] Errore:', e.message); }
}

async function inviaQuesturaAuto() {
  console.log('🚔 [AUTO] Controllo schede da inviare...');
  try {
    const { data: cfgData } = await supabase.from('impostazioni').select('*').in('chiave', ['alloggiati_user', 'alloggiati_pass', 'alloggiati_ws']);
    const cfg = {}; (cfgData || []).forEach(r => cfg[r.chiave] = r.valore);
    if (!cfg.alloggiati_user || !cfg.alloggiati_pass || !cfg.alloggiati_ws) { console.log('🚔 [AUTO] Credenziali mancanti, skip.'); return; }
    const oggi = new Date();
    const ieri = new Date(oggi); ieri.setDate(ieri.getDate() - 1);
    const pad = n => String(n).padStart(2,'0');
    const ieriStr = `${ieri.getFullYear()}-${pad(ieri.getMonth()+1)}-${pad(ieri.getDate())}`;
    const oggiStr = `${oggi.getFullYear()}-${pad(oggi.getMonth()+1)}-${pad(oggi.getDate())}`;
    const { data: prens } = await supabase.from('prenotazioni').select('*').in('data_arrivo', [ieriStr, oggiStr]).eq('questura_inviata', 0).neq('stato', 'cancellata');
    if (!prens || !prens.length) { console.log('🚔 [AUTO] Nessuna scheda da inviare.'); return; }
    for (const pren of prens) {
      const { data: ospiti } = await supabase.from('ospiti').select('*').eq('prenotazione_id', pren.id);
      if (!ospiti || !ospiti.length) continue;
      try {
        const lines = buildAlloggiatiLines(ospiti, pren);
        const token = await generaTokenAW(cfg.alloggiati_user, cfg.alloggiati_pass, cfg.alloggiati_ws);
        const { esito, schedineValide } = await inviaSchedeAW(cfg.alloggiati_user, token, lines);
        if (esito === 'true' || (schedineValide && parseInt(schedineValide) > 0)) {
          await supabase.from('prenotazioni').update({ questura_inviata: 1 }).eq('id', pren.id);
          console.log('🚔 [AUTO] Inviata pren', pren.id, pren.ospite);
        }
      } catch(e) { console.error('🚔 [AUTO] Errore pren', pren.id, ':', e.message); }
    }
  } catch(e) { console.error('🚔 [AUTO] Errore generale:', e.message); }
}

let ultimaEmail = '', ultimaQuestura = '';
setInterval(async () => {
  const now = new Date();
  const ora = now.getHours(), minuti = now.getMinutes();
  const giornoOra = now.toDateString() + '-' + ora;
  if (ora === 8 && minuti < 5 && ultimaEmail !== giornoOra) { ultimaEmail = giornoOra; leggiEmailAuto(); }
  if (ora === 11 && minuti < 5 && ultimaQuestura !== giornoOra) { ultimaQuestura = giornoOra; inviaQuesturaAuto(); }
}, 5 * 60 * 1000);

setTimeout(inviaQuesturaAuto, 15000);

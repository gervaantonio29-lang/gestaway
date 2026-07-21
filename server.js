// ============================================================
// GESTAWAY — server.js (MULTI-TENANT)
// Piattaforma per piu' clienti: ogni "struttura" ha i propri
// dati isolati tramite struttura_id. Login vero (email+password)
// invece della password unica usata da Ca' de' Mari.
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const ws = require('ws');
const PDFDocument = require('pdfkit');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');
const { createChannexServices } = require('./channex');

process.on('uncaughtException', (err) => { console.error('❌ uncaughtException:', err.message, err.stack); });
process.on('unhandledRejection', (reason) => { console.error('❌ unhandledRejection:', reason); });

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.DB_URL || process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || '',
  { realtime: { transport: ws } }
);

// Stripe webhook ha bisogno del raw body PRIMA di express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET || '');
  } catch (err) {
    console.error('[Stripe Webhook] Firma non valida:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      await provisionaStruttura(session);
    } else if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const { error } = await supabase.from('strutture').update({ stato: 'cancellato' }).eq('stripe_subscription_id', subscription.id);
      if (error) console.error('[Stripe Webhook] Errore disattivazione struttura:', error.message);
      else console.log(`[Stripe Webhook] Struttura disattivata per subscription ${subscription.id}`);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[Stripe Webhook] Errore provisioning:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ────────────────────────────────────────────────────────────
// AUTH — email + password, sessioni con token in tabella
// ────────────────────────────────────────────────────────────
function generaToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Accesso non autorizzato.' });
  const { data: sessione } = await supabase
    .from('sessioni')
    .select('*, utenti(*)')
    .eq('token', token)
    .single();
  if (!sessione) return res.status(401).json({ error: 'Sessione non valida.' });
  if (new Date(sessione.scade_il) < new Date()) {
    await supabase.from('sessioni').delete().eq('token', token);
    return res.status(401).json({ error: 'Sessione scaduta.' });
  }
  const { data: struttura } = await supabase.from('strutture').select('stato').eq('id', sessione.struttura_id).single();
  if (struttura?.stato === 'cancellato') {
    await supabase.from('sessioni').delete().eq('token', token);
    return res.status(403).json({ error: 'Il tuo abbonamento è stato cancellato. Contatta info@gestaway.com per riattivarlo.' });
  }
  req.strutturaId = sessione.struttura_id;
  req.utenteId = sessione.utente_id;
  next();
}

app.post('/api/register', async (req, res) => {
  const { nome, email, password, cin } = req.body;
  if (!nome || !email || !password) return res.status(400).json({ error: 'Nome, email e password sono obbligatori.' });
  if (password.length < 8) return res.status(400).json({ error: 'La password deve avere almeno 8 caratteri.' });

  const { data: esistente } = await supabase.from('utenti').select('id').eq('email', email).single();
  if (esistente) return res.status(409).json({ error: 'Esiste gia\u0300 un account con questa email.' });

  const trialScade = new Date();
  trialScade.setDate(trialScade.getDate() + 14);

  const { data: struttura, error: erroreStruttura } = await supabase
    .from('strutture')
    .insert({ nome, email, cin: cin || null, piano: 'base', stato: 'trial', trial_scade_il: trialScade.toISOString().slice(0, 10) })
    .select().single();
  if (erroreStruttura) return res.status(500).json({ error: erroreStruttura.message });

  const passwordHash = await bcrypt.hash(password, 10);
  const { data: utente, error: erroreUtente } = await supabase
    .from('utenti')
    .insert({ struttura_id: struttura.id, email, password_hash: passwordHash, ruolo: 'owner' })
    .select().single();
  if (erroreUtente) {
    await supabase.from('strutture').delete().eq('id', struttura.id);
    return res.status(500).json({ error: erroreUtente.message });
  }

  const token = generaToken();
  await supabase.from('sessioni').insert({ token, struttura_id: struttura.id, utente_id: utente.id });
  res.json({ ok: true, token, struttura: { id: struttura.id, nome: struttura.nome, piano: struttura.piano, stato: struttura.stato } });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e password sono obbligatorie.' });

  const { data: utente } = await supabase.from('utenti').select('*, strutture(*)').eq('email', email).single();
  if (!utente) return res.status(401).json({ error: 'Credenziali non valide.' });

  const passwordOk = await bcrypt.compare(password, utente.password_hash);
  if (!passwordOk) return res.status(401).json({ error: 'Credenziali non valide.' });

  if (utente.strutture?.stato === 'cancellato') {
    return res.status(403).json({ error: 'Il tuo abbonamento è stato cancellato. Contatta info@gestaway.com per riattivarlo.' });
  }

  const token = generaToken();
  await supabase.from('sessioni').insert({ token, struttura_id: utente.struttura_id, utente_id: utente.id });
  res.json({
    ok: true, token,
    struttura: { id: utente.strutture.id, nome: utente.strutture.nome, piano: utente.strutture.piano, stato: utente.strutture.stato },
  });
});

app.post('/api/logout', requireAuth, async (req, res) => {
  const token = req.headers['x-auth-token'];
  await supabase.from('sessioni').delete().eq('token', token);
  res.json({ ok: true });
});

app.get('/api/sessione', requireAuth, async (req, res) => {
  const { data: struttura } = await supabase.from('strutture').select('*').eq('id', req.strutturaId).single();
  res.json({ autenticato: true, struttura });
});

// ────────────────────────────────────────────────────────────
// RESET PASSWORD
// ────────────────────────────────────────────────────────────
app.post('/api/password/richiedi-reset', async (req, res) => {
  const { email } = req.body;
  // Risposta sempre generica: non rivela se l'email esiste o no.
  if (!email) return res.json({ ok: true });
  try {
    const { data: utente } = await supabase.from('utenti').select('id').eq('email', email).single();
    if (utente) {
      const token = generaToken();
      const scadeIl = new Date(Date.now() + 60 * 60 * 1000); // 1 ora
      await supabase.from('utenti').update({ reset_token: token, reset_scade_il: scadeIl.toISOString() }).eq('id', utente.id);
      if (process.env.SYSTEM_EMAIL_USER && process.env.SYSTEM_EMAIL_PASS) {
        const t = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.SYSTEM_EMAIL_USER, pass: process.env.SYSTEM_EMAIL_PASS } });
        const link = `${process.env.BASE_URL || 'https://www.gestaway.com'}/reset-password?token=${token}`;
        await t.sendMail({
          from: process.env.SYSTEM_EMAIL_USER, to: email,
          subject: 'Reimposta la tua password Gestaway',
          text: `Hai richiesto di reimpostare la password del tuo account Gestaway.\n\nClicca qui per scegliere una nuova password (link valido 1 ora):\n${link}\n\nSe non hai richiesto tu il reset, ignora questa email.`,
        });
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[Reset Password] Errore:', e.message);
    res.json({ ok: true }); // non rivelare errori interni al client
  }
});

app.post('/api/password/reset', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Dati mancanti.' });
  if (password.length < 8) return res.status(400).json({ error: 'La password deve avere almeno 8 caratteri.' });
  const { data: utente } = await supabase.from('utenti').select('id, reset_scade_il').eq('reset_token', token).single();
  if (!utente) return res.status(400).json({ error: 'Link non valido o già usato.' });
  if (new Date(utente.reset_scade_il) < new Date()) return res.status(400).json({ error: 'Link scaduto, richiedine uno nuovo.' });
  const passwordHash = await bcrypt.hash(password, 10);
  await supabase.from('utenti').update({ password_hash: passwordHash, reset_token: null, reset_scade_il: null }).eq('id', utente.id);
  res.json({ ok: true });
});

// ────────────────────────────────────────────────────────────
// STRIPE CHECKOUT
// ────────────────────────────────────────────────────────────
const PIANI = {
  base: process.env.STRIPE_PRICE_BASE,
  professionale: process.env.STRIPE_PRICE_PROFESSIONALE,
  domus: process.env.STRIPE_PRICE_DOMUS,
};
const PIANI_SENZA_TRIAL = ['domus'];
const CIN_REGEX = /^IT\d{3}\d{3}[A-Z0-9]{2}[A-Z0-9]{1,8}$/;

app.post('/api/checkout', async (req, res) => {
  const { piano, nome, email, cin } = req.body;
  if (!piano || !nome || !email || !cin) return res.status(400).json({ error: 'Dati mancanti.' });
  const priceId = PIANI[piano];
  if (!priceId) return res.status(400).json({ error: 'Piano non valido.' });
  const cinPulito = String(cin).replace(/\s+/g, '').toUpperCase();
  if (!CIN_REGEX.test(cinPulito)) return res.status(400).json({ error: 'CIN non valido.' });

  const { data: esistente } = await supabase.from('utenti').select('id').eq('email', email).single();
  if (esistente) return res.status(409).json({ error: 'Esiste già un account con questa email. Accedi invece di registrarti di nuovo.' });

  const subscriptionData = PIANI_SENZA_TRIAL.includes(piano)
    ? { metadata: { nome, piano, cin: cinPulito } }
    : { trial_period_days: 14, metadata: { nome, piano, cin: cinPulito } };

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      metadata: { nome, piano, cin: cinPulito },
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: subscriptionData,
      success_url: `${process.env.BASE_URL || 'https://gestaway.com'}/grazie?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL || 'https://gestaway.com'}/attiva`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: 'Errore pagamento.' });
  }
});

// Crea automaticamente struttura + utente dopo un pagamento riuscito.
// La password iniziale viene generata casualmente e inviata via email
// (in alternativa si puo' reindirizzare l'utente a una pagina che
// gli chiede di impostarla al primo accesso).
async function provisionaStruttura(session) {
  const email = session.customer_email || session.customer_details?.email;
  const { nome, piano, cin } = session.metadata || {};
  if (!email || !nome) { console.error('[Provisioning] Dati mancanti nel webhook Stripe'); return; }

  const { data: esistente } = await supabase.from('utenti').select('id').eq('email', email).single();
  if (esistente) { console.log('[Provisioning] Utente gia\u0300 esistente, salto:', email); return; }

  const passwordTemp = crypto.randomBytes(6).toString('hex');
  const passwordHash = await bcrypt.hash(passwordTemp, 10);

  const { data: struttura, error: e1 } = await supabase.from('strutture').insert({
    nome, email, cin: cin || null, piano: piano || 'base', stato: 'attivo',
    stripe_customer_id: session.customer, stripe_subscription_id: session.subscription,
    max_strutture_fisiche: piano === 'professionale' ? 3 : piano === 'personalizzato' ? 999 : 1,
  }).select().single();
  if (e1) { console.error('[Provisioning] Errore creazione struttura:', e1.message); return; }

  const { error: e2 } = await supabase.from('utenti').insert({
    struttura_id: struttura.id, email, password_hash: passwordHash, ruolo: 'owner',
  });
  if (e2) { console.error('[Provisioning] Errore creazione utente:', e2.message); return; }

  console.log(`[Provisioning] ✅ Nuova struttura creata: ${nome} (${email})`);

  // Invio email con la password temporanea, se le credenziali SMTP di sistema sono configurate
  try {
    if (process.env.SYSTEM_EMAIL_USER && process.env.SYSTEM_EMAIL_PASS) {
      const t = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.SYSTEM_EMAIL_USER, pass: process.env.SYSTEM_EMAIL_PASS } });
      await t.sendMail({
        from: process.env.SYSTEM_EMAIL_USER, to: email,
        subject: 'Benvenuto su Gestaway — il tuo account e\u0300 pronto',
        text: `Ciao ${nome},\n\nIl tuo account Gestaway e\u0300 attivo!\n\nAccedi su ${process.env.BASE_URL || 'https://gestaway.com'}/gestionale con:\nEmail: ${email}\nPassword temporanea: ${passwordTemp}\n\nTi consigliamo di cambiarla al primo accesso.\n\nBenvenuto a bordo!`,
      });
    }
  } catch (e) { console.error('[Provisioning] Errore invio email:', e.message); }
}

// ────────────────────────────────────────────────────────────
// STATIC PAGES
// ────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/gestionale', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gestionale.html')));
app.get('/attiva', (req, res) => res.sendFile(path.join(__dirname, 'public', 'attiva.html')));
app.get('/grazie', (req, res) => res.sendFile(path.join(__dirname, 'public', 'grazie.html')));
app.get('/reset-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));
app.get('/sitemap.xml', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sitemap.xml')));
app.get('/robots.txt', (req, res) => res.sendFile(path.join(__dirname, 'public', 'robots.txt')));

// ─── CHANNEX SERVICES (istanza condivisa, property_id per struttura) ──
const channex = createChannexServices(supabase);
if (process.env.CHANNEX_API_KEY) {
  channex.bookings.startPolling();
} else {
  console.warn('[Channex] CHANNEX_API_KEY non impostata — polling disabilitato');
}

// Webhook Channex: pubblico, nessun token di sessione (chiamato da Channex stesso).
// Deve restare PRIMA del gate app.use('/api', requireAuth) qui sotto.
// Se CHANNEX_WEBHOOK_SECRET è impostata, l'URL configurato su Channex deve
// includere ?secret=<valore> per essere accettato.
app.post('/api/channex/webhook', async (req, res) => {
  if (process.env.CHANNEX_WEBHOOK_SECRET && req.query.secret !== process.env.CHANNEX_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Non autorizzato.' });
  }
  try {
    const payload = req.body;
    const event = payload?.event || payload?.type;
    try { await supabase.from('channex_log').insert({ tipo: 'webhook', dettagli: payload, esito: 'ok', messaggio: 'Webhook: ' + event }); } catch(e) {}
    if (event === 'booking' || event === 'BookingRevision' || payload?.booking_id) {
      channex.bookings.poll().catch(err => console.error('[Webhook] Errore poll:', err.message));
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ errore: err.message }); }
});

module.exports = { app, supabase, requireAuth, PORT };

// ============================================================
// TUTTE LE ROTTE /api/* DA QUI IN AVANTI RICHIEDONO LOGIN
// ============================================================
app.use('/api', requireAuth);

// ─── APPARTAMENTI ─────────────────────────────────────────────
app.get('/api/appartamenti', async (req, res) => {
  const { data, error } = await supabase.from('appartamenti').select('*').eq('struttura_id', req.strutturaId).order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.post('/api/appartamenti', async (req, res) => {
  const { data: struttura } = await supabase.from('strutture').select('max_strutture_fisiche').eq('id', req.strutturaId).single();
  const { count } = await supabase.from('appartamenti').select('id', { count: 'exact', head: true }).eq('struttura_id', req.strutturaId);
  if (struttura && count >= struttura.max_strutture_fisiche) {
    return res.status(403).json({ error: `Il tuo piano consente al massimo ${struttura.max_strutture_fisiche} strutture. Passa a un piano superiore per aggiungerne altre.` });
  }
  const { data, error } = await supabase.from('appartamenti').insert({ ...req.body, struttura_id: req.strutturaId }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ id: data.id });
});
app.put('/api/appartamenti/:id', async (req, res) => {
  const { error } = await supabase.from('appartamenti').update(req.body).eq('id', req.params.id).eq('struttura_id', req.strutturaId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});
app.delete('/api/appartamenti/:id', async (req, res) => {
  const { error } = await supabase.from('appartamenti').delete().eq('id', req.params.id).eq('struttura_id', req.strutturaId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── PRENOTAZIONI ─────────────────────────────────────────────
app.get('/api/prenotazioni', async (req, res) => {
  const { data, error } = await supabase.from('prenotazioni').select('*, appartamenti(nome)').eq('struttura_id', req.strutturaId).order('data_arrivo', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(p => ({ ...p, appartamento_nome: p.appartamenti?.nome || '—' })));
});
app.post('/api/prenotazioni', async (req, res) => {
  const uid = 'manual_' + Date.now();
  const { data, error } = await supabase.from('prenotazioni').insert({ ...req.body, uid, struttura_id: req.strutturaId, stato: 'confermata', questura_inviata: 0 }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ id: data.id });
});
app.put('/api/prenotazioni/:id', async (req, res) => {
  const { error } = await supabase.from('prenotazioni').update(req.body).eq('id', req.params.id).eq('struttura_id', req.strutturaId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});
app.delete('/api/prenotazioni/:id', async (req, res) => {
  await supabase.from('ospiti').delete().eq('prenotazione_id', req.params.id);
  const { error } = await supabase.from('prenotazioni').delete().eq('id', req.params.id).eq('struttura_id', req.strutturaId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── OSPITI ───────────────────────────────────────────────────
app.get('/api/prenotazioni/:id/ospiti', async (req, res) => {
  const { data, error } = await supabase.from('ospiti').select('*').eq('prenotazione_id', req.params.id).eq('struttura_id', req.strutturaId);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.post('/api/prenotazioni/:id/ospiti', async (req, res) => {
  const { data, error } = await supabase.from('ospiti').insert({ ...req.body, prenotazione_id: req.params.id, struttura_id: req.strutturaId }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ id: data.id });
});
app.delete('/api/ospiti/:id', async (req, res) => {
  const { error } = await supabase.from('ospiti').delete().eq('id', req.params.id).eq('struttura_id', req.strutturaId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── IMPOSTAZIONI (chiave/valore per struttura) ────────────────
app.get('/api/impostazioni', async (req, res) => {
  const { data } = await supabase.from('impostazioni').select('*').eq('struttura_id', req.strutturaId);
  const cfg = {};
  (data || []).forEach(r => cfg[r.chiave] = r.valore);
  ['email_pass', 'switchbot_secret', 'alloggiati_pass', 'ross1000_pass'].forEach(k => { if (cfg[k]) cfg[k] = '••••••••'; });
  res.json(cfg);
});
app.get('/api/impostazioni/chiave/:chiave', async (req, res) => {
  const { data } = await supabase.from('impostazioni').select('valore').eq('struttura_id', req.strutturaId).eq('chiave', req.params.chiave).single();
  res.json({ valore: data?.valore || null });
});
app.post('/api/impostazioni', async (req, res) => {
  for (const [k, v] of Object.entries(req.body)) {
    if (v !== '••••••••') await supabase.from('impostazioni').upsert({ struttura_id: req.strutturaId, chiave: k, valore: v });
  }
  res.json({ ok: true });
});

// ─── STATS DASHBOARD ────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  const oggi = new Date();
  const pad = n => String(n).padStart(2, '0');
  const oggiStr = `${oggi.getFullYear()}-${pad(oggi.getMonth() + 1)}-${pad(oggi.getDate())}`;
  const { data: apts } = await supabase.from('appartamenti').select('id, nome').eq('struttura_id', req.strutturaId);
  const { data: prens } = await supabase.from('prenotazioni').select('*').eq('struttura_id', req.strutturaId).neq('stato', 'cancellata');
  const aptsMap = {};
  (apts || []).forEach(a => aptsMap[a.id] = a.nome);
  const inCasa = (prens || []).filter(p => p.data_arrivo <= oggiStr && p.data_partenza > oggiStr).length;
  const questuraDa = (prens || []).filter(p => !p.questura_inviata && p.data_arrivo <= oggiStr).length;
  const prossimi = (prens || []).filter(p => p.data_arrivo > oggiStr).sort((a, b) => a.data_arrivo > b.data_arrivo ? 1 : -1).slice(0, 5).map(p => ({ ...p, apt: aptsMap[p.appartamento_id] || '—' }));
  res.json({ totApt: (apts || []).length, totPren: (prens || []).length, inCasa, questuraDa, prossimi });
});

// ─── SYNC ICAL ──────────────────────────────────────────────────
function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Troppi redirect'));
    const client = url.startsWith('https') ? https : require('http');
    client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GestawaySync/1.0)' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        const nextUrl = r.headers.location.startsWith('http') ? r.headers.location : new URL(r.headers.location, url).href;
        r.resume(); return resolve(fetchUrl(nextUrl, redirectCount + 1));
      }
      if (r.statusCode >= 400) { r.resume(); return reject(new Error(`HTTP ${r.statusCode} su ${url}`)); }
      let data = ''; r.on('data', c => data += c); r.on('end', () => resolve(data));
    }).on('error', reject);
  });
}
function parseIcal(data, fonte, appartamento_id) {
  const events = [];
  data.split('BEGIN:VEVENT').slice(1).forEach(block => {
    const get = key => { const m = block.match(new RegExp(key + '[^:]*:([^\\r\\n]+)')); return m ? m[1].trim() : ''; };
    const uid = get('UID'), summary = get('SUMMARY'), dtstart = get('DTSTART'), dtend = get('DTEND');
    if (!uid || !dtstart || !dtend) return;
    const pd = d => d.replace(/[TZ]/g, '').replace(/(\d{4})(\d{2})(\d{2}).*/, '$1-$2-$3');
    events.push({ uid: uid + '_' + fonte, ospite: summary || 'Ospite', data_arrivo: pd(dtstart), data_partenza: pd(dtend), fonte, appartamento_id });
  });
  return events;
}
app.post('/api/sync/:id', async (req, res) => {
  const { data: apt } = await supabase.from('appartamenti').select('*').eq('id', req.params.id).eq('struttura_id', req.strutturaId).single();
  if (!apt) return res.status(404).json({ error: 'Non trovato.' });
  let importati = 0; const dettagli = [];
  for (const [url, fonte] of [[apt.ical_airbnb, 'Airbnb'], [apt.ical_booking, 'Booking']]) {
    if (!url) { dettagli.push({ fonte, stato: 'saltato', motivo: 'URL non configurato' }); continue; }
    try {
      const data = await fetchUrl(url);
      const eventiTrovati = parseIcal(data, fonte, apt.id);
      let importatiFonte = 0;
      for (const e of eventiTrovati) {
        if (fonte === 'Airbnb') { const n = (e.ospite || '').toUpperCase(); if (n.includes('NOT AVAILABLE') || n === 'CLOSED' || n === 'BLOCKED') continue; }
        const { error } = await supabase.from('prenotazioni').upsert({ ...e, struttura_id: req.strutturaId, stato: 'confermata', questura_inviata: 0 }, { onConflict: 'struttura_id,uid' });
        if (!error) { importati++; importatiFonte++; }
      }
      dettagli.push({ fonte, stato: 'ok', eventiNelFeed: eventiTrovati.length, importati: importatiFonte });
    } catch (e) { dettagli.push({ fonte, stato: 'errore', motivo: e.message }); }
  }
  res.json({ ok: true, importati, dettagli });
});

// ─── QUESTURA (Alloggiati Web) ──────────────────────────────────
function buildAlloggiatiLines(ospiti, pren) {
  const pad = (s, l) => String(s || '').substring(0, l).padEnd(l, ' ');
  const fmtData = d => { if (!d) return '          '; if (d.includes('/')) return d.padEnd(10, ' '); const p = d.split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : '          '; };
  return ospiti.map((o, i) => {
    const tipo = i === 0 ? '16' : '19', arrivo = fmtData(pren.data_arrivo);
    const giorni = (() => { if (!pren.data_arrivo || !pren.data_partenza) return ' 1'; const d = Math.round((new Date(pren.data_partenza) - new Date(pren.data_arrivo)) / 86400000); return String(d).padStart(2, ' '); })();
    const stato = pad(o.stato_nascita_codice || '100000100', 9), comune = o.comune_nascita_codice ? pad(o.comune_nascita_codice, 9) : '         ', prov = o.comune_nascita_provincia ? pad(o.comune_nascita_provincia, 2) : '  ';
    let riga = tipo + arrivo + giorni + pad(o.cognome, 50) + pad(o.nome, 30) + String(o.sesso || '1') + fmtData(o.data_nascita) + comune + prov + stato + stato;
    if (i === 0) { riga += pad(o.tipo_documento || 'IDENT', 5) + pad(o.numero_documento, 20) + (o.comune_nascita_codice ? pad(o.comune_nascita_codice, 9) : pad(stato, 9)); }
    else { riga += ' '.repeat(34); }
    return riga;
  });
}
function soapRequest(body) {
  return new Promise((resolve, reject) => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:all="AlloggiatiService"><soap:Header/><soap:Body>${body}</soap:Body></soap:Envelope>`;
    const opts = { hostname: 'alloggiatiweb.poliziadistato.it', path: '/service/Service.asmx', method: 'POST', headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(xml, 'utf8') } };
    const req = https.request(opts, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d)); });
    req.on('error', reject); req.write(xml); req.end();
  });
}
function xmlTag(xml, tag) { const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)); return m ? m[1].trim() : null; }
async function generaTokenAW(u, p, ws_key) {
  const body = `<all:GenerateToken><all:Utente>${u}</all:Utente><all:Password>${p}</all:Password><all:WsKey>${ws_key}</all:WsKey></all:GenerateToken>`;
  const r = await soapRequest(body);
  const token = xmlTag(r, 'token');
  if (!token) throw new Error('Token non ricevuto.');
  return token;
}
async function inviaSchedeAW(u, token, lines) {
  const righe = lines.map(r => `<all:string>${r}</all:string>`).join('\n');
  const body = `<all:Send xmlns:all="AlloggiatiService"><all:Utente>${u}</all:Utente><all:token>${token}</all:token><all:ElencoSchedine>${righe}</all:ElencoSchedine></all:Send>`;
  const r = await soapRequest(body);
  return { esito: xmlTag(r, 'esito'), errore: xmlTag(r, 'ErroreDettaglio'), schedineValide: xmlTag(r, 'SchedineValide') };
}
app.post('/api/questura/invia', async (req, res) => {
  const { data: pren } = await supabase.from('prenotazioni').select('*').eq('id', req.body.prenotazione_id).eq('struttura_id', req.strutturaId).single();
  const { data: ospiti } = await supabase.from('ospiti').select('*').eq('prenotazione_id', req.body.prenotazione_id).eq('struttura_id', req.strutturaId);
  if (!pren || !ospiti?.length) return res.status(400).json({ error: 'Dati mancanti.' });
  const lines = buildAlloggiatiLines(ospiti, pren), contenuto = lines.join('\r\n');
  const { data: cfgData } = await supabase.from('impostazioni').select('*').eq('struttura_id', req.strutturaId).in('chiave', ['alloggiati_user', 'alloggiati_pass', 'alloggiati_ws']);
  const cfg = {}; (cfgData || []).forEach(r => cfg[r.chiave] = r.valore);
  if (cfg.alloggiati_user && cfg.alloggiati_pass && cfg.alloggiati_ws) {
    try {
      const token = await generaTokenAW(cfg.alloggiati_user, cfg.alloggiati_pass, cfg.alloggiati_ws);
      const { esito, errore, schedineValide } = await inviaSchedeAW(cfg.alloggiati_user, token, lines);
      if (esito === 'true' || (schedineValide && parseInt(schedineValide) > 0)) {
        await supabase.from('prenotazioni').update({ questura_inviata: 1 }).eq('id', req.body.prenotazione_id);
        return res.json({ ok: true, inviato_automaticamente: true, contenuto });
      }
      return res.json({ ok: true, inviato_automaticamente: false, errore_invio: errore || 'Errore', contenuto });
    } catch (e) { return res.json({ ok: true, inviato_automaticamente: false, errore_invio: e.message, contenuto }); }
  }
  await supabase.from('prenotazioni').update({ questura_inviata: 1 }).eq('id', req.body.prenotazione_id);
  res.json({ ok: true, inviato_automaticamente: false, contenuto });
});

// ─── ROSS1000 (statistiche turistiche Regione Lombardia) ────────
function fmtDataRoss(d) { const dt = new Date(d); return `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`; }
app.get('/api/ross1000/genera-xml', async (req, res) => {
  try {
    const { mese, anno } = req.query;
    const meseN = parseInt(mese) || new Date().getMonth() + 1, annoN = parseInt(anno) || new Date().getFullYear();
    const { data: cfgData } = await supabase.from('impostazioni').select('*').eq('struttura_id', req.strutturaId).eq('chiave', 'ross1000_codice');
    const codice = cfgData?.[0]?.valore;
    if (!codice) return res.status(400).json({ error: 'Codice Ross1000 non configurato' });
    const dI = `${annoN}-${String(meseN).padStart(2, '0')}-01`;
    const ultimoGiorno = new Date(annoN, meseN, 0).getDate();
    const dF = `${annoN}-${String(meseN).padStart(2, '0')}-${String(ultimoGiorno).padStart(2, '0')}`;
    const { data: prens } = await supabase.from('prenotazioni').select('*').eq('struttura_id', req.strutturaId).gte('data_arrivo', dI).lte('data_arrivo', dF).neq('stato', 'cancellata');
    const ids = (prens || []).map(p => p.id);
    const { data: ospiti } = ids.length ? await supabase.from('ospiti').select('*').eq('struttura_id', req.strutturaId).in('prenotazione_id', ids) : { data: [] };
    let movimenti = '';
    const byDate = {};
    for (const p of (prens || [])) { if (!byDate[p.data_arrivo]) byDate[p.data_arrivo] = { p, ospiti: [] }; }
    for (const o of (ospiti || [])) { const p = (prens || []).find(p => p.id === o.prenotazione_id); if (p && byDate[p.data_arrivo]) byDate[p.data_arrivo].ospiti.push(o); }
    for (const [data, { p: pren, ospiti: osps }] of Object.entries(byDate).sort()) {
      const df = fmtDataRoss(data); let arrivi = '', partenze = '';
      for (const o of osps) {
        const isCapo = osps.indexOf(o) === 0, id = `${pren.id}-${o.id}`.substring(0, 20);
        const nascita = o.data_nascita ? fmtDataRoss(o.data_nascita) : '19800101';
        const italiano = !o.stato_nascita_codice || o.stato_nascita_codice === '100000100';
        const citt = italiano ? '100000100' : '100000200';
        const canaleIndiretto = pren.fonte === 'Airbnb' || pren.fonte === 'Booking';
        const canale = canaleIndiretto ? 'Indiretta web' : 'Diretta web';
        arrivi += `<arrivo><idswh>${id}</idswh><tipoalloggiato>${isCapo ? '16' : '19'}</tipoalloggiato><idcapo>${isCapo ? '' : pren.id + '-' + osps[0].id}</idcapo><sesso>${o.sesso === '2' ? 'F' : 'M'}</sesso><cittadinanza>${citt}</cittadinanza><statoresidenza>${citt}</statoresidenza><luogoresidenza>${o.comune_nascita_codice || ''}</luogoresidenza><datanascita>${nascita}</datanascita><statonascita>${citt}</statonascita><comunenascita></comunenascita><tipoturismo>Escursionistico/Naturalistico</tipoturismo><mezzotrasporto>Auto</mezzotrasporto><canaleprenotazione>${canale}</canaleprenotazione><titolostudio></titolostudio><professione></professione><esenzioneimposta></esenzioneimposta></arrivo>`;
        partenze += `<partenza><idswh>${id}</idswh><tipoalloggiato>${isCapo ? '16' : '19'}</tipoalloggiato><arrivo>${df}</arrivo></partenza>`;
      }
      movimenti += `<movimento><data>${df}</data><struttura><apertura>SI</apertura><camereoccupate>1</camereoccupate><cameredisponibili>1</cameredisponibili><lettidisponibili>2</lettidisponibili></struttura>${arrivi ? `<arrivi>${arrivi}</arrivi>` : ''}${partenze ? `<partenze>${partenze}</partenze>` : ''}</movimento>`;
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?><movimenti><codice>${codice}</codice><prodotto>Gestaway</prodotto>${movimenti}</movimenti>`;
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="ross1000_${annoN}${String(meseN).padStart(2, '0')}.xml"`);
    res.send(xml);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── EMAIL (lettura Airbnb via IMAP) ────────────────────────────
async function getEmailConfig(strutturaId) {
  const { data } = await supabase.from('impostazioni').select('*').eq('struttura_id', strutturaId).in('chiave', ['email_user', 'email_pass']);
  const cfg = {}; (data || []).forEach(r => cfg[r.chiave] = r.valore);
  return cfg.email_user && cfg.email_pass ? cfg : null;
}
app.post('/api/email/test', async (req, res) => {
  try {
    const cfg = await getEmailConfig(req.strutturaId);
    if (!cfg) return res.status(400).json({ error: 'Email non configurata.' });
    const t = nodemailer.createTransport({ service: 'gmail', auth: { user: cfg.email_user, pass: cfg.email_pass } });
    await t.sendMail({ from: cfg.email_user, to: cfg.email_user, subject: 'Test gestionale', text: 'Funziona!' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── RICEVUTE PDF ────────────────────────────────────────────────
app.get('/api/prenotazioni/:id/ricevuta', async (req, res) => {
  try {
    const { data: pren } = await supabase.from('prenotazioni').select('*, appartamenti(nome, indirizzo)').eq('id', req.params.id).eq('struttura_id', req.strutturaId).single();
    if (!pren) return res.status(404).json({ error: 'Prenotazione non trovata.' });
    const { data: cfgData } = await supabase.from('impostazioni').select('*').eq('struttura_id', req.strutturaId).in('chiave', ['ricevuta_numero_progressivo', 'ricevuta_ragione_sociale', 'ricevuta_indirizzo', 'ricevuta_telefono', 'ricevuta_email']);
    const cfg = {}; (cfgData || []).forEach(r => cfg[r.chiave] = r.valore);
    let numero = (parseInt(cfg.ricevuta_numero_progressivo) || 0) + 1;
    await supabase.from('impostazioni').upsert({ struttura_id: req.strutturaId, chiave: 'ricevuta_numero_progressivo', valore: String(numero) });

    const nottiCalc = (() => {
      if (!pren.data_arrivo || !pren.data_partenza) return 0;
      return Math.max(0, Math.round((new Date(pren.data_partenza) - new Date(pren.data_arrivo)) / 86400000));
    })();
    const totale = pren.importo ? parseFloat(pren.importo) : (nottiCalc * 40);
    const fmtDataIt = d => { if (!d) return '—'; const [y, m, g] = d.split('-'); const mesi = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic']; return `${g} ${mesi[parseInt(m) - 1]} ${y}`; };
    const oggi = new Date();
    const oggiStr = String(oggi.getDate()).padStart(2, '0') + '/' + String(oggi.getMonth() + 1).padStart(2, '0') + '/' + oggi.getFullYear();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="ricevuta_${numero}.pdf"`);
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    doc.pipe(res);
    doc.fontSize(20).font('Helvetica-Bold').text(cfg.ricevuta_ragione_sociale || 'Struttura', 50, 50);
    doc.fontSize(9).font('Helvetica').fillColor('#555')
      .text(cfg.ricevuta_indirizzo || '', 50, 78).text(cfg.ricevuta_telefono || '', 50, 92).text(cfg.ricevuta_email || '', 50, 106);
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#111').text('Ricevuta', 400, 50, { align: 'right', width: 145 });
    doc.fontSize(9).font('Helvetica').fillColor('#555')
      .text('N. ' + String(numero).padStart(3, '0'), 400, 80, { align: 'right', width: 145 })
      .text('Data: ' + oggiStr, 400, 94, { align: 'right', width: 145 });
    doc.moveTo(50, 130).lineTo(545, 130).strokeColor('#ddd').stroke();
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#111').text('Intestato a', 50, 145);
    doc.fontSize(11).font('Helvetica-Bold').text(pren.ospite || 'Ospite', 50, 160);
    doc.fontSize(9).font('Helvetica').fillColor('#555').text(pren.telefono_ospite || '', 50, 176).text(pren.email_ospite || '', 50, 190);
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#111').text('Dettagli soggiorno', 320, 145);
    doc.fontSize(9).font('Helvetica').fillColor('#333')
      .text(pren.appartamenti?.nome || 'Appartamento', 320, 160)
      .text(fmtDataIt(pren.data_arrivo) + '  →  ' + fmtDataIt(pren.data_partenza), 320, 176)
      .text(nottiCalc + ' notti', 320, 190);
    let y = 240;
    doc.moveTo(50, y).lineTo(545, y).strokeColor('#ddd').stroke(); y += 10;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#555')
      .text('Descrizione', 50, y).text('Notti', 320, y, { width: 60, align: 'center' })
      .text('Prezzo/notte', 390, y, { width: 75, align: 'right' }).text('Totale', 470, y, { width: 75, align: 'right' });
    y += 16; doc.moveTo(50, y).lineTo(545, y).strokeColor('#ddd').stroke(); y += 10;
    const prezzoNotte = nottiCalc > 0 ? (totale / nottiCalc) : totale;
    doc.fontSize(9).font('Helvetica').fillColor('#111')
      .text('Soggiorno — ' + (pren.appartamenti?.nome || 'Appartamento'), 50, y, { width: 260 })
      .text(String(nottiCalc), 320, y, { width: 60, align: 'center' })
      .text('€ ' + prezzoNotte.toFixed(2), 390, y, { width: 75, align: 'right' })
      .text('€ ' + totale.toFixed(2), 470, y, { width: 75, align: 'right' });
    y += 30; doc.moveTo(50, y).lineTo(545, y).strokeColor('#ddd').stroke(); y += 14;
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#111')
      .text('TOTALE', 390, y, { width: 75, align: 'right' }).text('€ ' + totale.toFixed(2), 470, y, { width: 75, align: 'right' });
    doc.end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CHANNEL MANAGER MULTI-TENANT ──────────────────────────────
// Ogni struttura ha una propria property Channex, mappata in channex_mappings
// (gestaway_property_id = struttura_id, channex_property_id = id su Channex).
async function getPropertyId(strutturaId) {
  const { data } = await supabase.from('channex_mappings').select('channex_property_id').eq('gestaway_property_id', strutturaId).single();
  return data?.channex_property_id || null;
}
// Verifica che un rate_plan_id appartenga davvero alla struttura autenticata,
// per evitare che una struttura modifichi le tariffe/restrizioni di un'altra
// indovinando/riusando un ratePlanId.
async function rateplanAppartieneAStruttura(ratePlanId, strutturaId) {
  const { data } = await supabase.from('channex_rate_mappings').select('id').eq('channex_rate_plan_id', ratePlanId).eq('gestaway_property_id', strutturaId).single();
  return !!data;
}
async function roomtypeAppartieneAStruttura(roomTypeId, strutturaId) {
  const { data } = await supabase.from('channex_room_mappings').select('id').eq('channex_room_type_id', roomTypeId).eq('gestaway_property_id', strutturaId).single();
  return !!data;
}
// Verifica che un thread/prenotazione Channex appartenga alla struttura autenticata,
// dato che tutte le strutture condividono lo stesso account Channex.
async function threadAppartieneAStruttura(threadId, propertyId) {
  try {
    const r = await channex.client.get(`/message_threads?filter[property_id]=${propertyId}&page[size]=100`);
    return (r?.data || []).some(t => t.id === threadId);
  } catch (e) { return false; }
}
async function bookingAppartieneAStruttura(bookingId, strutturaId) {
  const { data } = await supabase.from('channex_prenotazioni').select('struttura_id').eq('channex_booking_id', bookingId).single();
  return data?.struttura_id === strutturaId;
}

app.post('/api/channex/connetti', async (req, res) => {
  const { data: esistente } = await supabase.from('channex_mappings').select('channex_property_id').eq('gestaway_property_id', req.strutturaId).single();
  if (esistente) return res.status(409).json({ error: 'Questa struttura è già collegata a Channex.', channex_property_id: esistente.channex_property_id });

  const { titolo, valuta, timezone, paese, citta, indirizzo, cap } = req.body;
  if (!titolo || !valuta || !timezone || !paese || !citta || !indirizzo || !cap) {
    return res.status(400).json({ error: 'Dati struttura incompleti (titolo, valuta, timezone, paese, citta, indirizzo, cap sono obbligatori).' });
  }
  try {
    const r = await channex.client.createProperty({
      title: titolo, currency: valuta, timezone, country: paese, city: citta, address: indirizzo, zip_code: cap,
    });
    const channexPropertyId = r?.data?.id;
    if (!channexPropertyId) return res.status(500).json({ error: 'Channex non ha restituito un id property.' });
    const { error } = await supabase.from('channex_mappings').insert({ gestaway_property_id: req.strutturaId, struttura_id: req.strutturaId, channex_property_id: channexPropertyId });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, channex_property_id: channexPropertyId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/channex/full-sync', async (req, res) => {
  try { await channex.sync.fullSync(req.strutturaId); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ errore: err.message }); }
});
app.post('/api/channex/push-ari', async (req, res) => {
  const { tipo, values } = req.body;
  if (!tipo || !values?.length) return res.status(400).json({ errore: 'tipo e values[] obbligatori.' });
  const propertyId = await getPropertyId(req.strutturaId);
  if (!propertyId) return res.status(400).json({ errore: 'Struttura non ancora collegata a Channex.' });
  try {
    for (const v of values) {
      if (v.rate_plan_id && !(await rateplanAppartieneAStruttura(v.rate_plan_id, req.strutturaId))) {
        return res.status(403).json({ errore: `Rate plan ${v.rate_plan_id} non appartenente alla tua struttura.` });
      }
      if (v.room_type_id && !(await roomtypeAppartieneAStruttura(v.room_type_id, req.strutturaId))) {
        return res.status(403).json({ errore: `Room type ${v.room_type_id} non appartenente alla tua struttura.` });
      }
    }
    await channex.outbox.enqueue(tipo, { values: values.map(v => ({ ...v, property_id: propertyId })) }, req.strutturaId);
    await channex.outbox.flush();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ errore: err.message }); }
});
app.get('/api/channex/rate-plans', async (req, res) => {
  const propertyId = await getPropertyId(req.strutturaId);
  if (!propertyId) return res.status(400).json({ errore: 'Struttura non ancora collegata a Channex.' });
  try { res.json(await channex.client.listRatePlans(propertyId)); }
  catch (err) { res.status(500).json({ errore: err.message }); }
});
app.get('/api/channex/room-types', async (req, res) => {
  const propertyId = await getPropertyId(req.strutturaId);
  if (!propertyId) return res.status(400).json({ errore: 'Struttura non ancora collegata a Channex.' });
  try { res.json(await channex.client.listRoomTypes(propertyId)); }
  catch (err) { res.status(500).json({ errore: err.message }); }
});
app.put('/api/channex/rate-plans/:ratePlanId/restrictions', async (req, res) => {
  if (!(await rateplanAppartieneAStruttura(req.params.ratePlanId, req.strutturaId))) {
    return res.status(403).json({ error: 'Rate plan non appartenente alla tua struttura.' });
  }
  try {
    const { min_stay_arrival, min_stay_through } = req.body;
    const body = { rate_plan: {} };
    if (min_stay_arrival) body.rate_plan.min_stay_arrival = min_stay_arrival;
    if (min_stay_through) body.rate_plan.min_stay_through = min_stay_through;
    const r = await channex.client.put('/rate_plans/' + req.params.ratePlanId, body);
    res.json({ ok: true, data: r?.data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
const DATA_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const RESTRIZIONI_VALIDE = ['min_stay_arrival', 'min_stay_through', 'max_stay', 'stop_sell', 'closed_to_arrival', 'closed_to_departure'];
app.get('/api/channex/check-restrictions', async (req, res) => {
  const { date_from, date_to, restrictions } = req.query;
  if (!DATA_REGEX.test(date_from) || !DATA_REGEX.test(date_to)) return res.status(400).json({ error: 'date_from, date_to devono essere nel formato YYYY-MM-DD.' });
  const restrizione = restrictions || 'min_stay_arrival';
  if (!RESTRIZIONI_VALIDE.includes(restrizione)) return res.status(400).json({ error: 'Parametro restrictions non valido.' });
  const propertyId = await getPropertyId(req.strutturaId);
  if (!propertyId) return res.status(400).json({ errore: 'Struttura non ancora collegata a Channex.' });
  try {
    const r = await channex.client.get(`/restrictions?filter[property_id]=${propertyId}&filter[date][gte]=${date_from}&filter[date][lte]=${date_to}&filter[restrictions]=${restrizione}`);
    res.json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/channex/property-detail', async (req, res) => {
  const propertyId = await getPropertyId(req.strutturaId);
  if (!propertyId) return res.status(400).json({ errore: 'Struttura non ancora collegata a Channex.' });
  try { res.json(await channex.client.get('/properties/' + propertyId)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/channex/outbox', async (req, res) => {
  const { data, error } = await supabase.from('channex_outbox')
    .select('id, tipo, stato, tentativi, task_ids, errore, created_at, elaborato_at')
    .eq('struttura_id', req.strutturaId)
    .order('created_at', { ascending: false }).limit(100);
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});
app.get('/api/channex/outbox-detail/:id', async (req, res) => {
  const { data, error } = await supabase.from('channex_outbox').select('*').eq('id', req.params.id).eq('struttura_id', req.strutturaId).single();
  if (error) return res.status(404).json({ errore: 'Non trovato.' });
  res.json(data);
});
app.get('/api/channex/prenotazioni', async (req, res) => {
  const { data, error } = await supabase.from('channex_prenotazioni').select('*').eq('struttura_id', req.strutturaId).order('arrivo', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ errore: error.message });
  res.json(data);
});
app.post('/api/channex/poll-bookings', async (req, res) => {
  try { await channex.bookings.poll(); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ errore: err.message }); }
});

// ─── MESSAGGI CHANNEX ───────────────────────────────────────────
app.get('/api/messaggi/threads', async (req, res) => {
  const propertyId = await getPropertyId(req.strutturaId);
  if (!propertyId) return res.status(400).json({ errore: 'Struttura non ancora collegata a Channex.' });
  try {
    const r = await channex.client.get(`/message_threads?page[size]=50&filter[property_id]=${propertyId}`);
    const threads = (r?.data || []).map(t => ({
      id: t.id,
      title: t.attributes?.title,
      provider: t.attributes?.provider,
      is_closed: t.attributes?.is_closed,
      message_count: t.attributes?.message_count,
      last_message: t.attributes?.last_message,
      last_message_received_at: t.attributes?.last_message_received_at,
      booking_id: t.relationships?.booking?.data?.id || null,
    }));
    res.json(threads);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/messaggi/thread/:id', async (req, res) => {
  const propertyId = await getPropertyId(req.strutturaId);
  if (!propertyId) return res.status(400).json({ errore: 'Struttura non ancora collegata a Channex.' });
  if (!(await threadAppartieneAStruttura(req.params.id, propertyId))) {
    return res.status(403).json({ error: 'Thread non appartenente alla tua struttura.' });
  }
  try {
    const r = await channex.client.get('/message_threads/' + req.params.id + '/messages?page[size]=50');
    const msgs = (r?.data || []).map(m => ({
      id: m.id,
      message: m.attributes?.message,
      sender: m.attributes?.sender,
      inserted_at: m.attributes?.inserted_at,
      attachments: m.attributes?.attachments || [],
    })).reverse();
    res.json(msgs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/messaggi/invia', async (req, res) => {
  const { thread_id, booking_id, messaggio } = req.body;
  if (!messaggio) return res.status(400).json({ error: 'Messaggio mancante' });
  try {
    let result;
    if (thread_id) {
      const propertyId = await getPropertyId(req.strutturaId);
      if (!propertyId || !(await threadAppartieneAStruttura(thread_id, propertyId))) {
        return res.status(403).json({ error: 'Thread non appartenente alla tua struttura.' });
      }
      result = await channex.client.post('/message_threads/' + thread_id + '/messages', { message: { message: messaggio } });
    } else if (booking_id) {
      if (!(await bookingAppartieneAStruttura(booking_id, req.strutturaId))) {
        return res.status(403).json({ error: 'Prenotazione non appartenente alla tua struttura.' });
      }
      result = await channex.client.post('/bookings/' + booking_id + '/messages', { message: { message: messaggio } });
    } else {
      return res.status(400).json({ error: 'thread_id o booking_id richiesto' });
    }
    res.json({ ok: true, data: result?.data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/channex/iframe-token', async (req, res) => {
  const propertyId = await getPropertyId(req.strutturaId);
  if (!propertyId) return res.status(400).json({ errore: 'Struttura non ancora collegata a Channex.' });
  try {
    const { data: struttura } = await supabase.from('strutture').select('email').eq('id', req.strutturaId).single();
    const r = await channex.client.post('/auth/one_time_token', {
      one_time_token: { property_id: propertyId, username: struttura?.email || 'owner' }
    });
    const token = r?.data?.token;
    if (!token) return res.status(500).json({ error: 'Token non ricevuto' });
    res.json({ token, property_id: propertyId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────────────────────
// AVVIO
// ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Gestaway (multi-tenant) avviato su porta ${PORT}!\n`);
});

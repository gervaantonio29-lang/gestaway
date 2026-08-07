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

const channex = createChannexServices(supabase);
if (process.env.CHANNEX_API_KEY) {
  channex.bookings.startPolling();
} else {
  console.warn('[Channex] CHANNEX_API_KEY non impostata — polling disabilitato');
}

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
      await provisionaStruttura(event.data.object);
    } else if (event.type === 'invoice.payment_failed') {
      await pagamentoFallito(event.data.object);
    } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
      await pagamentoRiuscito(event.data.object);
    } else if (event.type === 'customer.subscription.deleted') {
      await abbonamentoDisdetto(event.data.object);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[Stripe Webhook] Errore:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Giorni di tolleranza dopo un pagamento fallito, prima della sospensione.
const GIORNI_TOLLERANZA = 10;

async function trovaStruttura(customerId, subscriptionId) {
  if (subscriptionId) {
    const { data } = await supabase.from('strutture').select('*').eq('stripe_subscription_id', subscriptionId).single();
    if (data) return data;
  }
  if (customerId) {
    const { data } = await supabase.from('strutture').select('*').eq('stripe_customer_id', customerId).single();
    if (data) return data;
  }
  return null;
}

// Pagamento fallito: non si sospende subito. La struttura entra "in ritardo" e
// continua a funzionare fino alla scadenza, cosi' l'host non resta fuori dal
// gestionale mentre ha ospiti in casa e schedine da mandare in Questura.
async function pagamentoFallito(invoice) {
  const s = await trovaStruttura(invoice.customer, invoice.subscription);
  if (!s) { console.warn('[Stripe] Pagamento fallito: struttura non trovata'); return; }
  if (s.stato === 'in_ritardo') return; // scadenza gia' fissata, non la sposto in avanti
  const scadenza = new Date();
  scadenza.setDate(scadenza.getDate() + GIORNI_TOLLERANZA);
  const { error } = await supabase.from('strutture')
    .update({ stato: 'in_ritardo', sospensione_il: scadenza.toISOString().slice(0, 10) })
    .eq('id', s.id);
  if (error) { console.error('[Stripe] Errore stato in_ritardo:', error.message); return; }
  console.log(`[Stripe] ${s.nome}: pagamento fallito, sospensione il ${scadenza.toISOString().slice(0, 10)}`);
  avvisaStruttura(s, 'Pagamento non riuscito',
    `Il pagamento dell'abbonamento Gestaway non e' andato a buon fine.\n\n` +
    `Il gestionale resta attivo fino al ${scadenza.toLocaleDateString('it-IT')}. ` +
    `Aggiorna il metodo di pagamento per non perdere l'accesso.`);
}

async function pagamentoRiuscito(invoice) {
  const s = await trovaStruttura(invoice.customer, invoice.subscription);
  if (!s || s.stato === 'attivo') return;
  const { error } = await supabase.from('strutture')
    .update({ stato: 'attivo', sospensione_il: null })
    .eq('id', s.id);
  if (error) { console.error('[Stripe] Errore riattivazione:', error.message); return; }
  console.log(`[Stripe] ${s.nome}: pagamento ricevuto, struttura riattivata`);
}

async function abbonamentoDisdetto(subscription) {
  const s = await trovaStruttura(subscription.customer, subscription.id);
  if (!s) return;
  const { error } = await supabase.from('strutture').update({ stato: 'sospeso' }).eq('id', s.id);
  if (error) { console.error('[Stripe] Errore sospensione:', error.message); return; }
  console.log(`[Stripe] ${s.nome}: abbonamento disdetto, struttura sospesa`);
}

async function avvisaStruttura(struttura, oggetto, testo) {
  try {
    if (!process.env.SYSTEM_EMAIL_USER || !process.env.SYSTEM_EMAIL_PASS) return;
    const t = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.SYSTEM_EMAIL_USER, pass: process.env.SYSTEM_EMAIL_PASS } });
    await t.sendMail({ from: process.env.SYSTEM_EMAIL_USER, to: struttura.email, subject: `Gestaway — ${oggetto}`, text: testo });
  } catch (e) { console.error('[Stripe] Errore invio avviso:', e.message); }
}

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
  req.strutturaId = sessione.struttura_id;
  req.utenteId = sessione.utente_id;

  // Logout e lettura sessione restano sempre accessibili: servono per uscire e
  // per far vedere al frontend il motivo del blocco.
  if (req.path === '/api/logout' || req.path === '/api/sessione') return next();

  const { data: struttura } = await supabase
    .from('strutture').select('stato, sospensione_il').eq('id', sessione.struttura_id).single();
  if (struttura) {
    // Scaduti i giorni di tolleranza la sospensione diventa effettiva.
    if (struttura.stato === 'in_ritardo' && struttura.sospensione_il &&
        struttura.sospensione_il < new Date().toISOString().slice(0, 10)) {
      await supabase.from('strutture').update({ stato: 'sospeso' }).eq('id', sessione.struttura_id);
      struttura.stato = 'sospeso';
    }
    // Si blocca solo 'sospeso': gli altri stati (attivo, in_ritardo, o valori
    // preesistenti) continuano a funzionare, per non chiudere fuori nessuno
    // per via di uno stato non previsto.
    if (struttura.stato === 'sospeso') {
      return res.status(402).json({
        error: 'Abbonamento sospeso. I dati sono conservati: regolarizza il pagamento per riattivare il gestionale.',
        sospeso: true,
      });
    }
    req.strutturaStato = struttura.stato;
    req.sospensioneIl = struttura.sospensione_il;
  }
  next();
}

// Registrazione libera disattivata: creava strutture con stato 'trial' e
// sessione valida senza alcun pagamento, e nulla faceva poi scadere la prova.
// L'unico ingresso e' il pagamento su Stripe (/api/checkout -> webhook ->
// provisionaStruttura). Per creare un account senza pagamento, inserire a mano
// le righe in 'strutture' e 'utenti'.
app.post('/api/register', (req, res) => {
  res.status(403).json({ error: 'Registrazione non disponibile: attiva un piano da /attiva.' });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e password sono obbligatorie.' });

  const { data: utente } = await supabase.from('utenti').select('*, strutture(*)').eq('email', email).single();
  if (!utente) return res.status(401).json({ error: 'Credenziali non valide.' });

  const passwordOk = await bcrypt.compare(password, utente.password_hash);
  if (!passwordOk) return res.status(401).json({ error: 'Credenziali non valide.' });

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
// STRIPE CHECKOUT
// ────────────────────────────────────────────────────────────
const PIANI = {
  base: process.env.STRIPE_PRICE_BASE,
  professionale: process.env.STRIPE_PRICE_PROFESSIONALE,
  domus: process.env.STRIPE_PRICE_DOMUS,
};
const PIANI_SENZA_TRIAL = ['base', 'professionale', 'domus', 'personalizzato'];
const CIN_REGEX = /^IT\d{3}\d{3}[A-Z0-9]{2}[A-Z0-9]{1,8}$/;

app.post('/api/checkout', async (req, res) => {
  const { piano, nome, email, cin } = req.body;
  if (!piano || !nome || !email || !cin) return res.status(400).json({ error: 'Dati mancanti.' });
  const priceId = PIANI[piano];
  if (!priceId) return res.status(400).json({ error: 'Piano non valido.' });
  const cinPulito = String(cin).replace(/\s+/g, '').toUpperCase();
  if (!CIN_REGEX.test(cinPulito)) return res.status(400).json({ error: 'CIN non valido.' });

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
app.get('/sitemap.xml', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sitemap.xml')));
app.get('/robots.txt', (req, res) => res.sendFile(path.join(__dirname, 'public', 'robots.txt')));


// ============================================================
// TUTTE LE ROTTE /api/* DA QUI IN AVANTI RICHIEDONO LOGIN
// ============================================================
// ─── WEBHOOK CHANNEX (pubblico, NO auth) ───────────────────────────────────────
app.post('/api/channex/webhook', async (req, res) => {
  try {
    const payload = req.body;
    const event = payload?.event || payload?.type;
    if (event === 'booking' || event === 'BookingRevision' || payload?.booking_id) {
      channex.bookings.poll().catch(err => console.error('[Webhook] Errore poll:', err.message));
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const codiciResetPasswordGestaway = {};
app.post('/api/password-reset/richiedi', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email mancante' });
    const emailNorm = email.toLowerCase().trim();
    const { data: utente } = await supabase.from('utenti').select('*').eq('email', emailNorm).single();
    if (!utente) return res.status(400).json({ error: 'Nessun account trovato con questa email' });
    if (!process.env.SYSTEM_EMAIL_USER || !process.env.SYSTEM_EMAIL_PASS) return res.status(500).json({ error: 'Sistema email non configurato' });
    const codice = String(Math.floor(100000 + Math.random() * 900000));
    codiciResetPasswordGestaway[emailNorm] = { codice, scadenza: Date.now() + 10 * 60 * 1000 };
    console.log('[RESET DEBUG] Utente trovato:', utente.email, '| Invio a:', emailNorm, '| Codice:', codice);
    const t = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.SYSTEM_EMAIL_USER, pass: process.env.SYSTEM_EMAIL_PASS } });
    const infoInvio = await t.sendMail({
      from: process.env.SYSTEM_EMAIL_USER,
      to: emailNorm,
      subject: 'Gestaway — Codice reset password',
      text: `Il tuo codice per reimpostare la password è: ${codice}\n\nValido per 10 minuti. Se non hai richiesto questo codice, ignora questa email.`
    });
    console.log('[RESET DEBUG] Email inviata, risposta SMTP:', JSON.stringify(infoInvio));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/admin/crea-struttura-diretta', async (req, res) => {
  try {
    const { secret, nome, email, piano, cin, password } = req.body;
    if (secret !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Non autorizzato' });
    if (!nome || !email || !password) return res.status(400).json({ error: 'Dati mancanti' });
    const { data: esistente } = await supabase.from('utenti').select('id').eq('email', email).single();
    if (esistente) return res.status(400).json({ error: 'Utente gia esistente con questa email' });
    const passwordHash = await bcrypt.hash(password, 10);
    const { data: struttura, error: e1 } = await supabase.from('strutture').insert({
      nome, email, cin: cin || null, piano: piano || 'base', stato: 'attivo',
      max_strutture_fisiche: piano === 'professionale' ? 3 : piano === 'personalizzato' ? 999 : 1,
    }).select().single();
    if (e1) return res.status(500).json({ error: 'Errore creazione struttura: ' + e1.message });
    const { error: e2 } = await supabase.from('utenti').insert({
      struttura_id: struttura.id, email, password_hash: passwordHash, ruolo: 'owner',
    });
    if (e2) return res.status(500).json({ error: 'Errore creazione utente: ' + e2.message });
    res.json({ ok: true, struttura_id: struttura.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/password-reset/conferma', async (req, res) => {
  try {
    const { email, codice, nuovaPassword } = req.body;
    if (!email || !codice || !nuovaPassword) return res.status(400).json({ error: 'Dati mancanti' });
    if (nuovaPassword.length < 6) return res.status(400).json({ error: 'La password deve avere almeno 6 caratteri' });
    const emailNorm = email.toLowerCase().trim();
    const richiesta = codiciResetPasswordGestaway[emailNorm];
    if (!richiesta) return res.status(400).json({ error: 'Nessuna richiesta di reset trovata, richiedine una nuova' });
    if (Date.now() > richiesta.scadenza) { delete codiciResetPasswordGestaway[emailNorm]; return res.status(400).json({ error: 'Codice scaduto, richiedine uno nuovo' }); }
    if (richiesta.codice !== String(codice).trim()) return res.status(400).json({ error: 'Codice errato' });
    const passwordHash2 = await bcrypt.hash(nuovaPassword, 10);
    await supabase.from('utenti').update({ password_hash: passwordHash2 }).eq('email', emailNorm);
    delete codiciResetPasswordGestaway[emailNorm];
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.use('/api', requireAuth);

// ─── CHANNEX SERVICES (istanza condivisa, property_id per struttura) ──

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
  // Numero ospiti = quanti documenti sono stati registrati per la questura.
  const { data: ospitiRows } = await supabase.from('ospiti').select('prenotazione_id').eq('struttura_id', req.strutturaId);
  const conteggioOspiti = {};
  (ospitiRows || []).forEach(o => { conteggioOspiti[o.prenotazione_id] = (conteggioOspiti[o.prenotazione_id] || 0) + 1; });
  res.json(data.map(p => ({ ...p, appartamento_nome: p.appartamenti?.nome || '—', numero_ospiti: conteggioOspiti[p.id] || ((p.adulti || 0) + (p.bambini || 0)) || 0 })));
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
  res.status(410).json({ ok: false, error: 'Sincronizzazione iCal disattivata: tutte le prenotazioni passano solo tramite Channex.' });
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

// ────────────────────────────────────────────────────────────
// AVVIO
// ────────────────────────────────────────────────────────────
// ============================================================
// CHANNEL MANAGER — endpoint multi-tenant (da aggiungere al
// server.js, dopo gli endpoint /api/prenotazioni/*, prima di
// app.listen). Ogni endpoint e' scoped per req.strutturaId.
// ============================================================

// Il "gestaway_property_id" di ogni struttura e' semplicemente
// il suo struttura_id: un solo Channex "property" per cliente
// (che puo' contenere piu' room_type = piu' appartamenti).

// ─── COLLEGAMENTO INIZIALE: crea la property su Channex ────────
app.get('/api/channex/ambiente-debug', async (req, res) => {
  res.json({
    CHANNEX_ENV: process.env.CHANNEX_ENV || '(non impostata)',
    base_url_effettivo: channex.client.baseUrl,
    api_key_presente: !!process.env.CHANNEX_API_KEY,
    api_key_primi_8_caratteri: (process.env.CHANNEX_API_KEY || '').slice(0, 8),
  });
});
app.get('/api/channex/tutte-le-properties-debug', async (req, res) => {
  try {
    const r = await channex.client.listProperties();
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/channex/invita-tutte-le-properties-debug', async (req, res) => {
  try {
    const lista = await channex.client.listProperties();
    const risultati = [];
    for (const p of (lista.data || [])) {
      try {
        await channex.client.post('/property_users', {
          invite: { property_id: p.id, user_email: 'cademarifaloppiocomo@gmail.com', role: 'user' }
        });
        risultati.push({ id: p.id, nome: p.attributes?.title, esito: 'ok' });
      } catch (e) {
        risultati.push({ id: p.id, nome: p.attributes?.title, esito: 'errore o gia\u0300 invitato: ' + e.message });
      }
    }
    res.json({ risultati });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/channex/connetti', async (req, res) => {
  try {
    const { data: strutturaRow } = await supabase.from('strutture').select('*').eq('id', req.strutturaId).single();
    if (!strutturaRow) return res.status(404).json({ error: 'Struttura non trovata.' });

    const { data: mappingEsistente } = await supabase.from('channex_mappings').select('*').eq('struttura_id', req.strutturaId).single();
    if (mappingEsistente) return res.json({ ok: true, gia_connessa: true, channex_property_id: mappingEsistente.channex_property_id });

    // Crea la property su Channex
    const propertyAttrs = {
      title: strutturaRow.nome,
      currency: 'EUR',
      email: strutturaRow.email,
      timezone: 'Europe/Rome',
      country: 'IT',
    };
    const result = await channex.client.createProperty(propertyAttrs);
    const channexPropertyId = result?.data?.id;
    if (!channexPropertyId) return res.status(500).json({ error: 'Channex non ha restituito un property ID.' });

    // Invita automaticamente l'account admin Gestaway a vedere questa property
    // sul pannello Channex (altrimenti resta visibile solo via API, mai sul sito).
    try {
      await channex.client.post('/property_users', {
        invite: { property_id: channexPropertyId, user_email: 'cademarifaloppiocomo@gmail.com', role: 'user' }
      });
    } catch (inviteErr) {
      console.warn('[Channex] Invito property user fallito (non bloccante):', inviteErr.message);
    }

    const { error } = await supabase.from('channex_mappings').insert({
      struttura_id: req.strutturaId,
      gestaway_property_id: req.strutturaId,
      gestaway_nome: strutturaRow.nome,
      channex_property_id: channexPropertyId,
    });
    if (error) return res.status(500).json({ error: error.message });

    res.json({ ok: true, gia_connessa: false, channex_property_id: channexPropertyId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/channex/stato', async (req, res) => {
  const { data } = await supabase.from('channex_mappings').select('*').eq('struttura_id', req.strutturaId).single();
  res.json({ connessa: !!data, mapping: data || null });
});

// ─── CAMERE (collega un appartamento a un room_type Channex) ───
app.post('/api/channex/camere', async (req, res) => {
  const { appartamento_id, nome, disponibilita_default } = req.body;
  const { data: mapping, error: mappingErr } = await supabase.from('channex_mappings').select('*').eq('struttura_id', req.strutturaId).single();
  if (!mapping) return res.status(400).json({ error: 'Collega prima la struttura a Channex.', mappingErr: mappingErr?.message });
  try {
    const payloadUsato = {
      property_id: mapping.channex_property_id,
      title: nome,
      count_of_rooms: disponibilita_default || 1,
      occ_adults: 2, occ_children: 0, occ_infants: 0,
      default_occupancy: 2,
    };
    const result = await channex.client.createRoomType(payloadUsato);
    const roomTypeId = result?.data?.id;
    if (!roomTypeId) return res.status(500).json({ error: 'Channex non ha restituito un room_type ID.', payload_usato: payloadUsato, risposta_channex: result });
    const gestawayRoomId = 'room-' + req.strutturaId.slice(0, 8) + '-' + Date.now();
    const { error } = await supabase.from('channex_room_mappings').insert({
      struttura_id: req.strutturaId,
      gestaway_property_id: req.strutturaId,
      gestaway_room_id: gestawayRoomId,
      gestaway_room_nome: nome,
      channex_room_type_id: roomTypeId,
      channex_room_type_nome: nome,
      disponibilita_default: disponibilita_default || 1,
      appartamento_gestaway_id: appartamento_id || null,
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, channex_room_type_id: roomTypeId, gestaway_room_id: gestawayRoomId });
  } catch (e) { res.status(500).json({ error: e.message, property_id_usato: mapping.channex_property_id }); }
});
app.get('/api/channex/camere', async (req, res) => {
  const { data, error } = await supabase.from('channex_room_mappings').select('*').eq('struttura_id', req.strutturaId);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── TARIFFE (collega un rate plan Channex, es. Base Airbnb/Booking) ──
app.post('/api/channex/tariffe', async (req, res) => {
  const { channex_room_type_id, nome, prezzo_default, min_stay_default, valuta } = req.body;
  const { data: mapping } = await supabase.from('channex_mappings').select('*').eq('struttura_id', req.strutturaId).single();
  if (!mapping) return res.status(400).json({ error: 'Collega prima la struttura a Channex.' });
  try {
    const result = await channex.client.createRatePlan({
      property_id: mapping.channex_property_id,
      room_type_id: channex_room_type_id,
      title: nome,
      currency: valuta || 'EUR',
      sell_mode: 'per_room',
      rate_mode: 'manual',
    });
    const ratePlanId = result?.data?.id;
    if (!ratePlanId) return res.status(500).json({ error: 'Channex non ha restituito un rate_plan ID.' });
    const { error } = await supabase.from('channex_rate_mappings').insert({
      struttura_id: req.strutturaId,
      gestaway_property_id: req.strutturaId,
      channex_room_type_id,
      channex_rate_plan_id: ratePlanId,
      channex_rate_plan_nome: nome,
      prezzo_default: prezzo_default || 100,
      min_stay_default: min_stay_default || 1,
      valuta: valuta || 'EUR',
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, channex_rate_plan_id: ratePlanId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/channex/tariffe', async (req, res) => {
  const { data, error } = await supabase.from('channex_rate_mappings').select('*').eq('struttura_id', req.strutturaId);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── FULL SYNC (solo disponibilita', mai tariffe/restrizioni) ──
app.post('/api/channex/full-sync', async (req, res) => {
  try {
    await channex.sync.fullSync(req.strutturaId, req.strutturaId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TARIFFE E RESTRIZIONI (form manuale, per range di date) ───
app.post('/api/channex/push-restrizioni', async (req, res) => {
  const { rate_plan_id, date_from, date_to, rate, min_stay_arrival, min_stay_through, max_stay, stop_sell, closed_to_arrival, closed_to_departure } = req.body;
  const { data: mapping } = await supabase.from('channex_mappings').select('*').eq('struttura_id', req.strutturaId).single();
  if (!mapping) return res.status(400).json({ error: 'Struttura non collegata a Channex.' });
  try {
    const values = [{
      property_id: mapping.channex_property_id,
      rate_plan_id, date_from, date_to,
      ...(rate != null && { rate: Math.round(rate * 100) }),
      ...(min_stay_arrival != null && { min_stay_arrival }),
      ...(min_stay_through != null && { min_stay_through }),
      ...(max_stay != null && { max_stay }),
      ...(stop_sell != null && { stop_sell }),
      ...(closed_to_arrival != null && { closed_to_arrival }),
      ...(closed_to_departure != null && { closed_to_departure }),
    }];
    await channex.outbox.enqueue(req.strutturaId, 'restrictions', { values }, req.strutturaId);
    await channex.outbox.flush();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PATTERN SETTIMANALE (min-stay fisso per giorno della settimana) ──
app.put('/api/channex/rate-plans/:ratePlanId/pattern-settimanale', async (req, res) => {
  try {
    const { pattern } = req.body; // array di 7 numeri, Lun..Dom
    if (!Array.isArray(pattern) || pattern.length !== 7) return res.status(400).json({ error: 'pattern deve essere un array di 7 numeri (Lun..Dom).' });
    const body = { rate_plan: { min_stay_arrival: pattern, min_stay_through: pattern } };
    const r = await channex.client.put('/rate_plans/' + req.params.ratePlanId, body);
    res.json({ ok: true, data: r?.data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── VERIFICA RESTRIZIONI (per debug/controllo dal frontend) ───
app.get('/api/channex/check-restrictions', async (req, res) => {
  const { date_from, date_to, restrictions } = req.query;
  const { data: mapping } = await supabase.from('channex_mappings').select('*').eq('struttura_id', req.strutturaId).single();
  if (!mapping) return res.status(400).json({ error: 'Struttura non collegata a Channex.' });
  try {
    const r = await channex.client.get(`/restrictions?filter[property_id]=${mapping.channex_property_id}&filter[date][gte]=${date_from}&filter[date][lte]=${date_to}&filter[restrictions]=${restrictions || 'min_stay_through'}`);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PRENOTAZIONI DA CHANNEX (per la vista Channel Manager) ────
app.get('/api/channex/prenotazioni', async (req, res) => {
  const { data, error } = await supabase.from('channex_prenotazioni').select('*').eq('struttura_id', req.strutturaId).order('arrivo', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── MESSAGGI (iframe Channex + API dirette) ────────────────────
app.get('/api/channex/iframe-token', async (req, res) => {
  const { data: mapping } = await supabase.from('channex_mappings').select('*').eq('struttura_id', req.strutturaId).single();
  if (!mapping) return res.status(400).json({ error: 'Struttura non collegata a Channex.' });
  try {
    const r = await channex.client.post('/auth/one_time_token', {
      one_time_token: { property_id: mapping.channex_property_id, username: 'admin' }
    });
    const token = r?.data?.token;
    if (!token) return res.status(500).json({ error: 'Token non ricevuto.' });
    res.json({ token, channex_property_id: mapping.channex_property_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/messaggi/threads', async (req, res) => {
  try {
    const r = await channex.client.get('/message_threads?page[size]=100');
    const threads = (r?.data || []).map(t => ({
      id: t.id, title: t.attributes?.title, provider: t.attributes?.provider,
      is_closed: t.attributes?.is_closed, message_count: t.attributes?.message_count,
      last_message: t.attributes?.last_message, last_message_received_at: t.attributes?.last_message_received_at,
      booking_id: t.relationships?.booking?.data?.id || null,
    }));
    res.json(threads);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/messaggi/thread/:id', async (req, res) => {
  try {
    const r = await channex.client.get('/message_threads/' + req.params.id + '/messages?page[size]=50');
    const msgs = (r?.data || []).map(m => ({
      id: m.id, message: m.attributes?.message, sender: m.attributes?.sender,
      inserted_at: m.attributes?.inserted_at, attachments: m.attributes?.attachments || [],
    })).reverse();
    res.json(msgs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/messaggi/invia', async (req, res) => {
  const { thread_id, booking_id, messaggio } = req.body;
  if (!messaggio) return res.status(400).json({ error: 'Messaggio mancante.' });
  try {
    let result;
    if (thread_id) result = await channex.client.post('/message_threads/' + thread_id + '/messages', { message: { message: messaggio } });
    else if (booking_id) result = await channex.client.post('/bookings/' + booking_id + '/messages', { message: { message: messaggio } });
    else return res.status(400).json({ error: 'thread_id o booking_id richiesto.' });
    res.json({ ok: true, data: result?.data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


function fmtD(d){const dt=new Date(d);return `${dt.getFullYear()}${String(dt.getMonth()+1).padStart(2,'0')}${String(dt.getDate()).padStart(2,'0')}`;}
app.get('/api/ross1000/genera-xml', async (req,res) => {
  try{
    const{mese,anno}=req.query;
    const meseN=parseInt(mese)||new Date().getMonth()+1,annoN=parseInt(anno)||new Date().getFullYear();
    const{data:cfg}=await supabase.from('impostazioni').select('*').eq('struttura_id',req.strutturaId).in('chiave',['ross1000_codice']);
    const impost={}; (cfg||[]).forEach(r=>impost[r.chiave]=r.valore);
    if(!impost.ross1000_codice)return res.status(400).json({error:'Codice Ross1000 non configurato'});
    const{data:appartamenti}=await supabase.from('appartamenti').select('id').eq('struttura_id',req.strutturaId);
    const totCamere=(appartamenti||[]).length||1;
    const totPostiLetto=totCamere*2;
    const dI=`${annoN}-${String(meseN).padStart(2,'0')}-01`;
    const ultimoGiorno=new Date(annoN,meseN,0).getDate();
    const dF=`${annoN}-${String(meseN).padStart(2,'0')}-${String(ultimoGiorno).padStart(2,'0')}`;
    const{data:prens}=await supabase.from('prenotazioni').select('*').eq('struttura_id',req.strutturaId).lt('data_arrivo',dF).gt('data_partenza',dI).neq('stato','cancellata').neq('fonte','blocco');
    const ids=(prens||[]).map(p=>p.id);
    const{data:ospiti}=ids.length?await supabase.from('ospiti').select('*').eq('struttura_id',req.strutturaId).in('prenotazione_id',ids):{data:[]};
    const ospitiPerPren={};
    (ospiti||[]).forEach(o=>{(ospitiPerPren[o.prenotazione_id]=ospitiPerPren[o.prenotazione_id]||[]).push(o);});
    let movimenti='';
    for(let g=1; g<=ultimoGiorno; g++){
      const dataStr=`${annoN}-${String(meseN).padStart(2,'0')}-${String(g).padStart(2,'0')}`;
      const df=fmtD(dataStr);
      const attivePren=(prens||[]).filter(p=>p.data_arrivo<=dataStr && p.data_partenza>dataStr);
      const camereoccupate=attivePren.length;
      const apertura=camereoccupate>0?'SI':'NO';
      let arrivi='',partenze='';
      for(const pren of (prens||[]).filter(p=>p.data_arrivo===dataStr)){
        const osps=ospitiPerPren[pren.id]||[];
        osps.forEach((o,idx)=>{
          const isCapo=idx===0,id=`${pren.id}-${o.id}`.substring(0,20);
          const nascita=o.data_nascita?fmtD(o.data_nascita):'19800101';
          const citt=o.nazionalita==='ITA'||!o.nazionalita?'100000100':'100000200';
          const canale=pren.fonte==='Airbnb'||pren.fonte==='Booking'?'Indiretta web':'Diretta web';
          arrivi+=`<arrivo><idswh>${id}</idswh><tipoalloggiato>${isCapo?'16':'19'}</tipoalloggiato><idcapo>${isCapo?'':pren.id+'-'+osps[0].id}</idcapo><sesso>${o.sesso||'M'}</sesso><cittadinanza>${citt}</cittadinanza><statoresidenza>${citt}</statoresidenza><luogoresidenza>${o.luogo_nascita||''}</luogoresidenza><datanascita>${nascita}</datanascita><statonascita>${citt}</statonascita><comunenascita></comunenascita><tipoturismo>Escursionistico/Naturalistico</tipoturismo><mezzotrasporto>Auto</mezzotrasporto><canaleprenotazione>${canale}</canaleprenotazione><titolostudio></titolostudio><professione></professione><esenzioneimposta></esenzioneimposta></arrivo>`;
        });
      }
      for(const pren of (prens||[]).filter(p=>p.data_partenza===dataStr)){
        const osps=ospitiPerPren[pren.id]||[];
        osps.forEach((o,idx)=>{
          const isCapo=idx===0,id=`${pren.id}-${o.id}`.substring(0,20);
          partenze+=`<partenza><idswh>${id}</idswh><tipoalloggiato>${isCapo?'16':'19'}</tipoalloggiato><arrivo>${fmtD(pren.data_arrivo)}</arrivo></partenza>`;
        });
      }
      movimenti+=`<movimento><data>${df}</data><struttura><apertura>${apertura}</apertura><camereoccupate>${camereoccupate}</camereoccupate><cameredisponibili>${totCamere}</cameredisponibili><lettidisponibili>${totPostiLetto}</lettidisponibili></struttura>${arrivi?`<arrivi>${arrivi}</arrivi>`:''}${partenze?`<partenze>${partenze}</partenze>`:''}</movimento>`;
    }
    const xml=`<?xml version="1.0" encoding="UTF-8"?><movimenti><codice>${impost.ross1000_codice}</codice><prodotto>Gestaway</prodotto>${movimenti}</movimenti>`;
    res.setHeader('Content-Type','application/xml');
    res.setHeader('Content-Disposition',`attachment; filename="ross1000_${annoN}${String(meseN).padStart(2,'0')}.xml"`);
    res.send(xml);
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/debug/diagnosi-rete', requireAuth, async (req, res) => {
  const https = require('https');
  const testConnessione = (host, timeout=8000) => new Promise((resolve) => {
    const start = Date.now();
    const r = https.request({ hostname: host, path: '/', method: 'GET', timeout }, (resp) => {
      resolve({ host, ok: true, status: resp.statusCode, ms: Date.now()-start });
      resp.resume();
    });
    r.on('timeout', () => { r.destroy(); resolve({ host, ok: false, errore: 'TIMEOUT', ms: Date.now()-start }); });
    r.on('error', (e) => resolve({ host, ok: false, errore: e.message, ms: Date.now()-start }));
    r.end();
  });
  const risultati = await Promise.all([
    testConnessione('www.google.com'),
    testConnessione('alloggiatiweb.poliziadistato.it'),
  ]);
  res.json({ risultati });
});
app.get('/api/debug/room-types/:propertyId', requireAuth, async (req, res) => {
  try {
    const r = await channex.client.get('/room_types?filter[property_id]=' + req.params.propertyId);
    const lista = (r?.data || []).map(rt => ({ id: rt.id, nome: rt.attributes?.title, occupazione: rt.attributes?.default_occupancy }));
    res.json({ lista, raw: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/debug/rate-plans/:propertyId', requireAuth, async (req, res) => {
  try {
    const r = await channex.client.get('/rate_plans?filter[property_id]=' + req.params.propertyId);
    const lista = (r?.data || []).map(rp => ({ id: rp.id, nome: rp.attributes?.title, room_type_id: rp.relationships?.room_type?.data?.id }));
    res.json({ lista });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/debug/bookings-raw/:propertyId', requireAuth, async (req, res) => {
  try {
    const r = await channex.client.getBookings(req.params.propertyId, 1, 3);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/admin/backfill-prenotazioni/:propertyId', requireAuth, async (req, res) => {
  try {
    let pagina = 1, totali = 0, elaborati = [];
    while (true) {
      const r = await channex.client.getBookings(req.params.propertyId, pagina, 50);
      const lista = r?.data || [];
      if (!lista.length) break;
      for (const booking of lista) {
        await channex.bookings._processRevision({ attributes: booking.attributes });
        elaborati.push({ id: booking.attributes.booking_id, ospite: booking.attributes.customer?.name, status: booking.attributes.status });
        totali++;
      }
      if (lista.length < 50) break;
      pagina++;
    }
    res.json({ ok: true, totali, elaborati });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});
app.listen(PORT, () => {
  console.log(`\n✅ Gestaway (multi-tenant) avviato su porta ${PORT}!\n`);
});

module.exports = { app, supabase, requireAuth, PORT };

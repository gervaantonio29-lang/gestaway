const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');

process.on('uncaughtException', (err) => { console.error('❌ uncaughtException:', err.message, err.stack); });
process.on('unhandledRejection', (reason) => { console.error('❌ unhandledRejection:', reason); });

const app = express();
const PORT = process.env.PORT || 3000;
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_KEY || '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const crypto = require('crypto');
const STATIC_TOKEN = crypto.createHash('sha256').update('gestionale-' + ADMIN_PASSWORD + '-token').digest('hex');
app.use(cors());
app.use(express.json());

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token || token !== STATIC_TOKEN) return res.status(401).json({ error: 'Non autorizzato' });
  next();
}
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) res.json({ ok: true, token: STATIC_TOKEN });
  else res.status(401).json({ error: 'Password errata' });
});
app.post('/api/logout', (req, res) => res.json({ ok: true }));

// ─── STRIPE ───────────────────────────────────────────────────────────────────
// Aggiorna i STRIPE_PRICE_* in Railway con i nuovi price ID (prezzi aggiornati):
// Base: €49/mese, Professionale: €89/mese, Domus: €59/mese
const PIANI = {
  base: process.env.STRIPE_PRICE_BASE,
  professionale: process.env.STRIPE_PRICE_PROFESSIONALE,
  domus: process.env.STRIPE_PRICE_DOMUS,
};
const PIANI_SENZA_TRIAL = ['domus'];
const CIN_REGEX = /^IT\d{3}\d{3}[A-Z0-9]{2}[A-Z0-9]{1,8}$/;

app.post('/api/checkout', async (req, res) => {
  const { piano, nome, email, struttura, cin } = req.body;
  if (!piano || !nome || !email || !struttura || !cin) return res.status(400).json({ error: 'Dati mancanti' });
  const priceId = PIANI[piano];
  if (!priceId) return res.status(400).json({ error: 'Piano non valido' });
  const cinPulito = String(cin).replace(/\s+/g, '').toUpperCase();
  if (!CIN_REGEX.test(cinPulito)) return res.status(400).json({ error: 'CIN non valido' });
  const subscriptionData = PIANI_SENZA_TRIAL.includes(piano)
    ? { metadata: { nome, struttura, piano, cin: cinPulito } }
    : { trial_period_days: 14, metadata: { nome, struttura, piano, cin: cinPulito } };
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      metadata: { nome, struttura, piano, cin: cinPulito },
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: subscriptionData,
      success_url: `${process.env.BASE_URL || 'https://gestaway.com'}/grazie?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL || 'https://gestaway.com'}/attiva`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: 'Errore pagamento' });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/gestionale', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gestionale.html')));
app.get('/checkin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'checkin.html')));
app.get('/attiva', (req, res) => res.sendFile(path.join(__dirname, 'public', 'attiva.html')));
app.get('/grazie', (req, res) => res.sendFile(path.join(__dirname, 'public', 'grazie.html')));
app.get('/sitemap.xml', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sitemap.xml')));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`\n✅ Gestaway avviato su porta ${PORT}!\n`));

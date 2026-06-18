const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Supabase Gestaway
const supabase = process.env.SUPABASE_URL ? createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY || ''
) : null;

// ─── LANDING PAGE ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/sitemap.xml', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
});

// ─── ATTIVAZIONE ──────────────────────────────────────────────────────────────
app.get('/attiva', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'attiva.html'));
});

// Prezzi Stripe (price IDs da Stripe dashboard)
const PIANI = {
  starter: process.env.STRIPE_PRICE_STARTER,
  domus: process.env.STRIPE_PRICE_DOMUS,
  pro: process.env.STRIPE_PRICE_PRO,
  unlimited: process.env.STRIPE_PRICE_UNLIMITED,
};

// Piani SENZA prova gratuita (es. Domus include il sito + dominio)
const PIANI_SENZA_TRIAL = ['domus'];
const GIORNI_TRIAL = 14;

// Formato CIN: IT + 3 cifre (prov.) + 3 cifre (comune) + 2 alfanum. (classif.) + 1-8 alfanum.
const CIN_REGEX = /^IT\d{3}\d{3}[A-Z0-9]{2}[A-Z0-9]{1,8}$/;

app.post('/api/checkout', async (req, res) => {
  const { piano, nome, email, struttura, cin } = req.body;
  if (!piano || !nome || !email || !struttura || !cin) {
    return res.status(400).json({ error: 'Dati mancanti' });
  }
  const priceId = PIANI[piano];
  if (!priceId) return res.status(400).json({ error: 'Piano non valido' });

  // Validazione formato CIN (normalizzo: tolgo spazi, maiuscolo)
  const cinPulito = String(cin).replace(/\s+/g, '').toUpperCase();
  if (!CIN_REGEX.test(cinPulito)) {
    return res.status(400).json({ error: 'CIN non valido' });
  }

  // Prova gratuita: 14 giorni per tutti i piani tranne quelli in PIANI_SENZA_TRIAL
  const subscriptionData = PIANI_SENZA_TRIAL.includes(piano)
    ? { metadata: { nome, struttura, piano, cin: cinPulito } }
    : { trial_period_days: GIORNI_TRIAL, metadata: { nome, struttura, piano, cin: cinPulito } };

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

// ─── GRAZIE ───────────────────────────────────────────────────────────────────
app.get('/grazie', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'grazie.html'));
});
// ─── STATIC FILES ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`✅ Gestaway avviato su porta ${PORT}!`);
});
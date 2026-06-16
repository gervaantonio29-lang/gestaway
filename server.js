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
  pro: process.env.STRIPE_PRICE_PRO,
  unlimited: process.env.STRIPE_PRICE_UNLIMITED,
};

app.post('/api/checkout', async (req, res) => {
  const { piano, nome, email, struttura } = req.body;
  if (!piano || !nome || !email || !struttura) {
    return res.status(400).json({ error: 'Dati mancanti' });
  }
  const priceId = PIANI[piano];
  if (!priceId) return res.status(400).json({ error: 'Piano non valido' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      metadata: { nome, struttura, piano },
      line_items: [{ price: priceId, quantity: 1 }],
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

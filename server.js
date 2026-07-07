const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const ws = require('ws');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');

process.on('uncaughtException', (err) => { console.error('❌ uncaughtException:', err.message, err.stack); });
process.on('unhandledRejection', (reason) => { console.error('❌ unhandledRejection:', reason); });

const app = express();
const PORT = process.env.PORT || 3000;
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || '',
  { realtime: { transport: ws } }
);
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

// ─── STRIPE — Base €39, Professionale €79, Domus €49 ─────────────────────────
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

// ─── STATIC ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/gestionale', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gestionale.html')));
app.get('/checkin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'checkin.html')));
app.get('/attiva', (req, res) => res.sendFile(path.join(__dirname, 'public', 'attiva.html')));
app.get('/grazie', (req, res) => res.sendFile(path.join(__dirname, 'public', 'grazie.html')));
app.get('/sitemap.xml', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sitemap.xml')));
app.use(express.static(path.join(__dirname, 'public')));

// ─── CALENDARIO PUBBLICO ──────────────────────────────────────────────────────
app.get('/api/disponibilita/:nomeAppartamento', async (req, res) => {
  const { data: apt } = await supabase.from('appartamenti').select('id, prezzo_base, iva_percent, markup_sito, rincaro_bassa, rincaro_media, rincaro_alta').ilike('nome', req.params.nomeAppartamento).single();
  if (!apt) return res.status(404).json({ error: 'Appartamento non trovato' });
  const oggi = new Date();
  const y = oggi.getFullYear(), m = String(oggi.getMonth()+1).padStart(2,'0');
  const inizioMese = `${y}-${m}-01`;
  const fine = new Date(y, oggi.getMonth()+3, 0);
  const fineMese = `${fine.getFullYear()}-${String(fine.getMonth()+1).padStart(2,'0')}-${String(fine.getDate()).padStart(2,'0')}`;
  const { data: prens } = await supabase.from('prenotazioni').select('data_arrivo, data_partenza').eq('appartamento_id', apt.id).neq('stato', 'cancellata').gte('data_partenza', inizioMese).lte('data_arrivo', fineMese);
  const prezzi = {};
  if (apt.prezzo_base) {
    const base = apt.prezzo_base, iva = (apt.iva_percent||0)/100, sito = (apt.markup_sito||0)/100;
    const baseConIva = base*(1+iva);
    prezzi.bassa = +(baseConIva*(1+sito)*(1+(apt.rincaro_bassa||0)/100)).toFixed(2);
    prezzi.media = +(baseConIva*(1+sito)*(1+(apt.rincaro_media||0)/100)).toFixed(2);
    prezzi.alta  = +(baseConIva*(1+sito)*(1+(apt.rincaro_alta||0)/100)).toFixed(2);
  }
  res.json({ prenotazioni: prens||[], prezzi });
});

// ─── RICHIESTA DAL SITO ───────────────────────────────────────────────────────
app.post('/api/richiesta', async (req, res) => {
  const { nome, email, data_arrivo, data_partenza, ospiti, messaggio } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome mancante' });
  const uid = 'richiesta_' + Date.now();
  const { error } = await supabase.from('prenotazioni').insert({ uid, ospite: nome, email_ospite: email, data_arrivo: data_arrivo||null, data_partenza: data_partenza||null, stato: 'richiesta', fonte: 'sito', note: `Ospiti: ${ospiti||'—'}\n${messaggio||''}`.trim(), questura_inviata: 0 });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── CHECK-IN PUBBLICO ────────────────────────────────────────────────────────
app.get('/api/checkin/cerca', async (req, res) => {
  const { nome, data, orario } = req.query;
  if (!nome || !data) return res.status(400).json({ error: 'Parametri mancanti' });
  const { data: prens } = await supabase.from('prenotazioni').select('id, data_arrivo, data_partenza, ospite, appartamenti(nome)').eq('data_arrivo', data);
  if (!prens || !prens.length) return res.status(404).json({ error: 'Non trovata' });
  const nomeQuery = nome.toLowerCase().trim();
  const pren = prens.find(p => { const ospite = (p.ospite||'').toLowerCase(); return ospite.includes(nomeQuery) || nomeQuery.split(' ').some(part => part.length > 2 && ospite.includes(part)); });
  if (!pren) return res.status(404).json({ error: 'Non trovata' });
  if (orario) await supabase.from('prenotazioni').update({ orario_arrivo: orario }).eq('id', pren.id);
  res.json({ ...pren, appartamento_nome: pren.appartamenti?.nome || '—' });
});
app.get('/api/checkin/:id', async (req, res) => {
  const { data, error } = await supabase.from('prenotazioni').select('id, data_arrivo, data_partenza, ospite, appartamenti(nome)').eq('id', req.params.id).single();
  if (error || !data) return res.status(404).json({ error: 'Non trovata' });
  res.json({ ...data, appartamento_nome: data.appartamenti?.nome || '—' });
});
app.get('/api/checkin/:id/ospiti', async (req, res) => {
  const { data, error } = await supabase.from('ospiti').select('*').eq('prenotazione_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});
app.post('/api/checkin/:id/ospiti', async (req, res) => {
  const { data, error } = await supabase.from('ospiti').insert({ ...req.body, prenotazione_id: parseInt(req.params.id) }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ id: data.id });
});
app.delete('/api/checkin/ospiti/:id', async (req, res) => {
  const { error } = await supabase.from('ospiti').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});
app.post('/api/checkin/:id/conferma', async (req, res) => {
  const { error } = await supabase.from('prenotazioni').update({ checkin_completato: true }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

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
  const { data, error } = await supabase.from('prenotazioni').select('*, appartamenti(nome)').order('data_arrivo', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(p => ({ ...p, appartamento_nome: p.appartamenti?.nome || '—' })));
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
  (data||[]).forEach(r => cfg[r.chiave] = r.valore);
  ['email_pass','switchbot_secret','alloggiati_pass'].forEach(k => { if (cfg[k]) cfg[k] = '••••••••'; });
  res.json(cfg);
});
app.post('/api/impostazioni', requireAuth, async (req, res) => {
  for (const [k, v] of Object.entries(req.body)) {
    if (v !== '••••••••') await supabase.from('impostazioni').upsert({ chiave: k, valore: v });
  }
  res.json({ ok: true });
});

// ─── STATS ────────────────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, async (req, res) => {
  const oggi = new Date();
  const pad = n => String(n).padStart(2,'0');
  const oggiStr = `${oggi.getFullYear()}-${pad(oggi.getMonth()+1)}-${pad(oggi.getDate())}`;
  const { data: apts } = await supabase.from('appartamenti').select('id, nome');
  const { data: prens } = await supabase.from('prenotazioni').select('*').neq('stato', 'cancellata');
  const aptsMap = {};
  (apts||[]).forEach(a => aptsMap[a.id] = a.nome);
  const inCasa = (prens||[]).filter(p => p.data_arrivo <= oggiStr && p.data_partenza > oggiStr).length;
  const questuraDa = (prens||[]).filter(p => !p.questura_inviata && p.data_arrivo <= oggiStr).length;
  const prossimi = (prens||[]).filter(p => p.data_arrivo > oggiStr).sort((a,b) => a.data_arrivo > b.data_arrivo ? 1:-1).slice(0,5).map(p => ({ ...p, apt: aptsMap[p.appartamento_id]||'—' }));
  res.json({ totApt: (apts||[]).length, totPren: (prens||[]).length, inCasa, questuraDa, prossimi });
});

// ─── SYNC ICAL ────────────────────────────────────────────────────────────────
function fetchUrl(url, redirectCount=0) {
  return new Promise((resolve,reject) => {
    if (redirectCount>5) return reject(new Error('Troppi redirect'));
    const client = url.startsWith('https') ? https : require('http');
    client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GestawaySync/1.0)' } }, (r) => {
      if (r.statusCode>=300 && r.statusCode<400 && r.headers.location) {
        const nextUrl = r.headers.location.startsWith('http') ? r.headers.location : new URL(r.headers.location,url).href;
        r.resume(); return resolve(fetchUrl(nextUrl, redirectCount+1));
      }
      if (r.statusCode>=400) { r.resume(); return reject(new Error(`HTTP ${r.statusCode} su ${url}`)); }
      let data=''; r.on('data',c=>data+=c); r.on('end',()=>resolve(data));
    }).on('error',reject);
  });
}
function parseIcal(data, fonte, appartamento_id) {
  const events=[];
  data.split('BEGIN:VEVENT').slice(1).forEach(block => {
    const get=key=>{const m=block.match(new RegExp(key+'[^:]*:([^\\r\\n]+)'));return m?m[1].trim():'';};
    const uid=get('UID'),summary=get('SUMMARY'),dtstart=get('DTSTART'),dtend=get('DTEND');
    if(!uid||!dtstart||!dtend) return;
    const pd=d=>d.replace(/[TZ]/g,'').replace(/(\d{4})(\d{2})(\d{2}).*/,'$1-$2-$3');
    events.push({uid:uid+'_'+fonte,ospite:summary||'Ospite',data_arrivo:pd(dtstart),data_partenza:pd(dtend),fonte,appartamento_id});
  });
  return events;
}
app.post('/api/sync/:id', requireAuth, async (req,res) => {
  const { data: apt } = await supabase.from('appartamenti').select('*').eq('id',req.params.id).single();
  if (!apt) return res.status(404).json({ error: 'Non trovato' });
  let importati=0; const dettagli=[];
  for (const [url,fonte] of [[apt.ical_airbnb,'Airbnb'],[apt.ical_booking,'Booking']]) {
    if (!url) { dettagli.push({fonte,stato:'saltato',motivo:'URL non configurato'}); continue; }
    try {
      const data=await fetchUrl(url);
      const eventiTrovati=parseIcal(data,fonte,apt.id);
      let importatiFonte=0;
      for (const e of eventiTrovati) {
        if (fonte==='Airbnb'){const n=(e.ospite||'').toUpperCase();if(n.includes('NOT AVAILABLE')||n==='CLOSED'||n==='BLOCKED')continue;}
        const{error}=await supabase.from('prenotazioni').upsert({...e,stato:'confermata',questura_inviata:0},{onConflict:'uid'});
        if(!error){importati++;importatiFonte++;}
      }
      dettagli.push({fonte,stato:'ok',eventiNelFeed:eventiTrovati.length,importati:importatiFonte});
    } catch(e) { dettagli.push({fonte,stato:'errore',motivo:e.message}); }
  }
  res.json({ok:true,importati,dettagli});
});

// ─── PULIZIA ─────────────────────────────────────────────────────────────────
app.post('/api/pulizia/not-available', requireAuth, async (req,res) => {
  const{data:prens}=await supabase.from('prenotazioni').select('id,ospite').eq('fonte','Airbnb');
  let rimossi=0;
  for(const p of (prens||[])){const n=(p.ospite||'').toUpperCase();if(n.includes('NOT AVAILABLE')||n==='CLOSED'||n==='BLOCKED'){await supabase.from('prenotazioni').delete().eq('id',p.id);rimossi++;}}
  res.json({ok:true,rimossi});
});

// ─── EMAIL ────────────────────────────────────────────────────────────────────
async function getEmailConfig() {
  const{data}=await supabase.from('impostazioni').select('*').in('chiave',['email_user','email_pass']);
  const cfg={}; (data||[]).forEach(r=>cfg[r.chiave]=r.valore);
  return cfg.email_user&&cfg.email_pass?cfg:null;
}
app.post('/api/email/test', requireAuth, async (req,res) => {
  try {
    const cfg=await getEmailConfig();
    if(!cfg) return res.status(400).json({error:'Email non configurata'});
    const t=nodemailer.createTransport({service:'gmail',auth:{user:cfg.email_user,pass:cfg.email_pass}});
    await t.sendMail({from:cfg.email_user,to:cfg.email_user,subject:'Test gestionale',text:'Funziona!'});
    res.json({ok:true});
  } catch(e){res.status(500).json({error:e.message});}
});
function parseDataEmail(g,m,a){
  const mesiEn={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  const mesiIt={gen:1,feb:2,mar:3,apr:4,mag:5,giu:6,lug:7,ago:8,set:9,ott:10,nov:11,dic:12};
  const n=mesiEn[m.toLowerCase()]||mesiIt[m.toLowerCase()]||parseInt(m);
  return n?`${a}-${String(n).padStart(2,'0')}-${String(g).padStart(2,'0')}`:null;
}
app.post('/api/email/leggi-airbnb', requireAuth, async (req,res) => {
  try {
    const cfg=await getEmailConfig();
    if(!cfg) return res.status(400).json({error:'Email non configurata'});
    const client=new ImapFlow({host:'imap.gmail.com',port:993,secure:true,auth:{user:cfg.email_user,pass:cfg.email_pass},logger:false});
    await client.connect();
    const lock=await client.getMailboxLock('INBOX');
    const aggiornati=[];
    try {
      const{data:prens}=await supabase.from('prenotazioni').select('*');
      for(const[from,tipoFonte]of[['airbnb.com','Airbnb'],['messaging.lodgify.com','Lodgify']]){
        const msgs=await client.search({from});
        for(const uid of msgs.slice(-200)){
          const msg=await client.fetchOne(uid,{source:true});
          const parsed=await simpleParser(msg.source);
          const testo=((parsed.text||'')+(parsed.html||'')).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
          let nome=null,checkin=null,guadagni=null;
          const nm=testo.match(/([A-Za-zàèéìòùÀÈÉÌÒÙ]+ [A-Za-zàèéìòùÀÈÉÌÒÙ]+) ha prenotato/i)||testo.match(/Reservation from ([A-Za-z]+ [A-Za-z]+)/i);
          if(nm)nome=nm[1].trim();
          const gm=testo.match(/Guadagni.*?€\s*([\d.,]+)/i)||testo.match(/You earn.*?\$\s*([\d.,]+)/i);
          if(gm)guadagni=parseFloat(gm[1].replace(',','.'));
          const cm=testo.match(/Check-in[:\s]+([a-z]{3})\s+(\d{1,2}),?\s+(\d{4})/i);
          if(cm)checkin=parseDataEmail(cm[2],cm[1],cm[3]);
          if(!nome&&!guadagni)continue;
          let pren=null;
          if(checkin)pren=(prens||[]).find(p=>p.fonte===tipoFonte&&p.data_arrivo===checkin);
          if(!pren&&nome)pren=(prens||[]).find(p=>p.fonte===tipoFonte&&(p.ospite==='Reserved'||p.ospite?.includes('Not available')));
          if(pren){const update={};if(nome)update.ospite=nome;if(guadagni)update.importo=guadagni;await supabase.from('prenotazioni').update(update).eq('id',pren.id);aggiornati.push({id:pren.id,nome,guadagni});}
        }
      }
    } finally{lock.release();}
    await client.logout();
    res.json({ok:true,aggiornati:aggiornati.length,dettagli:aggiornati});
  }catch(e){res.status(500).json({error:e.message});}
});

// ─── QUESTURA ─────────────────────────────────────────────────────────────────
function buildAlloggiatiLines(ospiti,pren){
  const pad=(s,l)=>String(s||'').substring(0,l).padEnd(l,' ');
  const fmtData=d=>{if(!d)return'          ';if(d.includes('/'))return d.padEnd(10,' ');const p=d.split('-');return p.length===3?`${p[2]}/${p[1]}/${p[0]}`:'          ';};
  return ospiti.map((o,i)=>{
    const tipo=i===0?'16':'19',arrivo=fmtData(pren.data_arrivo);
    const giorni=(()=>{if(!pren.data_arrivo||!pren.data_partenza)return' 1';const d=Math.round((new Date(pren.data_partenza)-new Date(pren.data_arrivo))/86400000);return String(d).padStart(2,' ');})();
    const stato=pad(o.stato_nascita_codice||'100000100',9),comune=o.comune_nascita_codice?pad(o.comune_nascita_codice,9):'         ',prov=o.comune_nascita_provincia?pad(o.comune_nascita_provincia,2):'  ';
    let riga=tipo+arrivo+giorni+pad(o.cognome,50)+pad(o.nome,30)+String(o.sesso||'1')+fmtData(o.data_nascita)+comune+prov+stato+stato;
    if(i===0){riga+=pad(o.tipo_documento||'IDENT',5)+pad(o.numero_documento,20)+(o.comune_nascita_codice?pad(o.comune_nascita_codice,9):pad(stato,9));}
    else{riga+=' '.repeat(34);}
    return riga;
  });
}
function soapRequest(action,body){
  return new Promise((resolve,reject)=>{
    const xml=`<?xml version="1.0" encoding="utf-8"?>\n<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:all="AlloggiatiService"><soap:Header/><soap:Body>${body}</soap:Body></soap:Envelope>`;
    const opts={hostname:'alloggiatiweb.poliziadistato.it',path:'/service/Service.asmx',method:'POST',headers:{'Content-Type':'application/soap+xml; charset=utf-8','Content-Length':Buffer.byteLength(xml,'utf8')}};
    const req=https.request(opts,(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>resolve(d));});
    req.on('error',reject);req.write(xml);req.end();
  });
}
function xmlTag(xml,tag){const m=xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));return m?m[1].trim():null;}
async function generaTokenAW(u,p,ws_key){
  const body=`<all:GenerateToken><all:Utente>${u}</all:Utente><all:Password>${p}</all:Password><all:WsKey>${ws_key}</all:WsKey></all:GenerateToken>`;
  const r=await soapRequest('GenerateToken',body);
  const token=xmlTag(r,'token');
  if(!token)throw new Error('Token non ricevuto');
  return token;
}
async function inviaSchedeAW(u,token,lines){
  const righe=lines.map(r=>`<all:string>${r}</all:string>`).join('\n');
  const body=`<all:Send xmlns:all="AlloggiatiService"><all:Utente>${u}</all:Utente><all:token>${token}</all:token><all:ElencoSchedine>${righe}</all:ElencoSchedine></all:Send>`;
  const r=await soapRequest('Send',body);
  return{esito:xmlTag(r,'esito'),errore:xmlTag(r,'ErroreDettaglio'),schedineValide:xmlTag(r,'SchedineValide')};
}
app.post('/api/questura/invia', requireAuth, async (req,res) => {
  const{data:pren}=await supabase.from('prenotazioni').select('*').eq('id',req.body.prenotazione_id).single();
  const{data:ospiti}=await supabase.from('ospiti').select('*').eq('prenotazione_id',req.body.prenotazione_id);
  if(!pren||!ospiti?.length)return res.status(400).json({error:'Dati mancanti'});
  const lines=buildAlloggiatiLines(ospiti,pren),contenuto=lines.join('\r\n');
  const{data:cfgData}=await supabase.from('impostazioni').select('*').in('chiave',['alloggiati_user','alloggiati_pass','alloggiati_ws']);
  const cfg={}; (cfgData||[]).forEach(r=>cfg[r.chiave]=r.valore);
  if(cfg.alloggiati_user&&cfg.alloggiati_pass&&cfg.alloggiati_ws){
    try{
      const token=await generaTokenAW(cfg.alloggiati_user,cfg.alloggiati_pass,cfg.alloggiati_ws);
      const{esito,errore,schedineValide}=await inviaSchedeAW(cfg.alloggiati_user,token,lines);
      if(esito==='true'||(schedineValide&&parseInt(schedineValide)>0)){await supabase.from('prenotazioni').update({questura_inviata:1}).eq('id',req.body.prenotazione_id);return res.json({ok:true,inviato_automaticamente:true,contenuto});}
      else{return res.json({ok:true,inviato_automaticamente:false,errore_invio:errore||'Errore',contenuto});}
    }catch(e){return res.json({ok:true,inviato_automaticamente:false,errore_invio:e.message,contenuto});}
  }
  await supabase.from('prenotazioni').update({questura_inviata:1}).eq('id',req.body.prenotazione_id);
  res.json({ok:true,inviato_automaticamente:false,contenuto});
});

// ─── ROSS1000 ─────────────────────────────────────────────────────────────────
function fmtD(d){const dt=new Date(d);return `${dt.getFullYear()}${String(dt.getMonth()+1).padStart(2,'0')}${String(dt.getDate()).padStart(2,'0')}`;}
app.get('/api/ross1000/genera-xml', requireAuth, async (req,res) => {
  try{
    const{mese,anno}=req.query;
    const meseN=parseInt(mese)||new Date().getMonth()+1,annoN=parseInt(anno)||new Date().getFullYear();
    const{data:cfg}=await supabase.from('impostazioni').select('*').in('chiave',['ross1000_codice']);
    const impost={}; (cfg||[]).forEach(r=>impost[r.chiave]=r.valore);
    if(!impost.ross1000_codice)return res.status(400).json({error:'Codice Ross1000 non configurato'});
    const dI=`${annoN}-${String(meseN).padStart(2,'0')}-01`,dF=`${annoN}-${String(meseN).padStart(2,'0')}-31`;
    const{data:prens}=await supabase.from('prenotazioni').select('*').gte('data_arrivo',dI).lte('data_arrivo',dF).neq('stato','cancellata');
    const ids=(prens||[]).map(p=>p.id);
    const{data:ospiti}=ids.length?await supabase.from('ospiti').select('*').in('prenotazione_id',ids):{data:[]};
    let movimenti='';
    const byDate={};
    for(const p of (prens||[])){if(!byDate[p.data_arrivo])byDate[p.data_arrivo]={p,ospiti:[]};}
    for(const o of (ospiti||[])){const p=(prens||[]).find(p=>p.id===o.prenotazione_id);if(p&&byDate[p.data_arrivo])byDate[p.data_arrivo].ospiti.push(o);}
    for(const[data,{p:pren,ospiti:osps}]of Object.entries(byDate).sort()){
      const df=fmtD(data);let arrivi='',partenze='';
      for(const o of osps){
        const isCapo=osps.indexOf(o)===0,id=`${pren.id}-${o.id}`.substring(0,20);
        const nascita=o.data_nascita?fmtD(o.data_nascita):'19800101';
        const citt=o.nazionalita==='ITA'||!o.nazionalita?'100000100':'100000200';
        const canale=pren.canale==='Airbnb'||pren.canale==='Booking'?'Indiretta web':'Diretta web';
        arrivi+=`<arrivo><idswh>${id}</idswh><tipoalloggiato>${isCapo?'16':'19'}</tipoalloggiato><idcapo>${isCapo?'':pren.id+'-'+osps[0].id}</idcapo><sesso>${o.sesso||'M'}</sesso><cittadinanza>${citt}</cittadinanza><statoresidenza>${citt}</statoresidenza><luogoresidenza>${o.luogo_nascita||''}</luogoresidenza><datanascita>${nascita}</datanascita><statonascita>${citt}</statonascita><comunenascita></comunenascita><tipoturismo>Escursionistico/Naturalistico</tipoturismo><mezzotrasporto>Auto</mezzotrasporto><canaleprenotazione>${canale}</canaleprenotazione><titolostudio></titolostudio><professione></professione><esenzioneimposta></esenzioneimposta></arrivo>`;
        partenze+=`<partenza><idswh>${id}</idswh><tipoalloggiato>${isCapo?'16':'19'}</tipoalloggiato><arrivo>${df}</arrivo></partenza>`;
      }
      movimenti+=`<movimento><data>${df}</data><struttura><apertura>SI</apertura><camereoccupate>1</camereoccupate><cameredisponibili>1</cameredisponibili><lettidisponibili>2</lettidisponibili></struttura>${arrivi?`<arrivi>${arrivi}</arrivi>`:''}${partenze?`<partenze>${partenze}</partenze>`:''}</movimento>`;
    }
    const xml=`<?xml version="1.0" encoding="UTF-8"?><movimenti><codice>${impost.ross1000_codice}</codice><prodotto>Gestaway</prodotto>${movimenti}</movimenti>`;
    res.setHeader('Content-Type','application/xml');
    res.setHeader('Content-Disposition',`attachment; filename="ross1000_${annoN}${String(meseN).padStart(2,'0')}.xml"`);
    res.send(xml);
  }catch(e){res.status(500).json({error:e.message});}
});

// ─── AVVIO ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`\n✅ Gestaway avviato su porta ${PORT}!\n`));

// ─── JOB AUTOMATICI ───────────────────────────────────────────────────────────
async function leggiEmailAuto(){
  try{
    const cfg=await getEmailConfig();if(!cfg)return;
    const client=new ImapFlow({host:'imap.gmail.com',port:993,secure:true,auth:{user:cfg.email_user,pass:cfg.email_pass},logger:false});
    await client.connect();const lock=await client.getMailboxLock('INBOX');
    try{let c=0;for await(const msg of client.fetch({since:new Date(Date.now()-48*60*60*1000)},{source:true})){c++;}console.log('📧 [AUTO] Email lette:',c);}
    finally{lock.release();}
    await client.logout();
  }catch(e){console.error('📧 [AUTO] Errore:',e.message);}
}
async function inviaQuesturaAuto(){
  try{
    const{data:cfgData}=await supabase.from('impostazioni').select('*').in('chiave',['alloggiati_user','alloggiati_pass','alloggiati_ws']);
    const cfg={}; (cfgData||[]).forEach(r=>cfg[r.chiave]=r.valore);
    if(!cfg.alloggiati_user||!cfg.alloggiati_pass||!cfg.alloggiati_ws)return;
    const oggi=new Date(),ieri=new Date(oggi);ieri.setDate(ieri.getDate()-1);
    const pad=n=>String(n).padStart(2,'0');
    const ieriStr=`${ieri.getFullYear()}-${pad(ieri.getMonth()+1)}-${pad(ieri.getDate())}`;
    const oggiStr=`${oggi.getFullYear()}-${pad(oggi.getMonth()+1)}-${pad(oggi.getDate())}`;
    const{data:prens}=await supabase.from('prenotazioni').select('*').in('data_arrivo',[ieriStr,oggiStr]).eq('questura_inviata',0).neq('stato','cancellata');
    for(const pren of (prens||[])){
      const{data:ospiti}=await supabase.from('ospiti').select('*').eq('prenotazione_id',pren.id);
      if(!ospiti?.length)continue;
      try{
        const lines=buildAlloggiatiLines(ospiti,pren);
        const token=await generaTokenAW(cfg.alloggiati_user,cfg.alloggiati_pass,cfg.alloggiati_ws);
        const{esito,schedineValide}=await inviaSchedeAW(cfg.alloggiati_user,token,lines);
        if(esito==='true'||(schedineValide&&parseInt(schedineValide)>0)){await supabase.from('prenotazioni').update({questura_inviata:1}).eq('id',pren.id);console.log('🚔 [AUTO] Inviata pren',pren.id);}
      }catch(e){console.error('🚔 [AUTO] Errore pren',pren.id,':',e.message);}
    }
  }catch(e){console.error('🚔 [AUTO] Errore:',e.message);}
}
let ultimaEmail='',ultimaQuestura='';
setInterval(()=>{
  const now=new Date(),ora=now.getHours(),min=now.getMinutes(),k=now.toDateString()+'-'+ora;
  if(ora===8&&min<5&&ultimaEmail!==k){ultimaEmail=k;leggiEmailAuto();}
  if(ora===11&&min<5&&ultimaQuestura!==k){ultimaQuestura=k;inviaQuesturaAuto();}
},5*60*1000);
setTimeout(inviaQuesturaAuto,15000);

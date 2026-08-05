# Allineamento gestaway ↔ Cà de' Mari — leggere prima di modificare il gestionale

Questo file esiste perché due sessioni di Claude Code lavorano sugli stessi repo e
una ha già cancellato il lavoro dell'altra. Serve a evitare che succeda di nuovo.

## Regole di lavoro (le più importanti)

1. **`git pull` prima di ogni modifica.** Sempre.
2. **Mai riscrivere `public/gestionale.html` per intero.** Solo modifiche mirate al
   pezzo che serve. È un file da ~2400 righe che contiene funzioni di entrambe le
   sessioni: rigenerarlo da una copia in memoria cancella il lavoro altrui.
3. Prima di committare: `node -c server.js` e validazione dei blocchi `<script>`
   di `gestionale.html` (estrarli e passarli a `new Function()`).
4. Il deploy su Railway parte al push e ci mette 1–3 minuti. Verificare con `curl`
   sul dominio prima di considerare fatto il lavoro.
5. Endpoint `/api/debug/...` temporanei: usarli pure per diagnosticare, ma
   **rimuoverli sempre** prima di chiudere.

## Contesto dei due prodotti

- **`cademaricomo`** → cademaricomo.com. Single-tenant, **produzione reale** del B&B
  Cà de' Mari (Como): clienti e prenotazioni veri, massima cautela.
- **`gestaway`** → gestaway.com. SaaS multi-tenant, tenuto in parità di funzioni con
  cademaricomo. **Ogni query va scopata con `struttura_id` / `req.strutturaId`.**

Supabase gira con service-role key: **la RLS non protegge nulla**, l'isolamento fra
tenant è solo applicativo. Se si dimentica lo scoping, un tenant vede i dati di un altro.

## Cos'è successo (per capire perché questo file esiste)

Il commit `713fe0c "Fix Channel Manager multi-tenant e logo"` ha riscritto
`gestionale.html` partendo da una base vecchia (−633 righe), cancellando
l'allineamento con cademaricomo: pagina Prezzi, indicatori nel calendario, filtri
Questura, de-branding, tutto sparito.

Il commit `d0ab1e6 "Riallinea il gestionale a quello di Ca' de' Mari"` lo ha
riapplicato **sopra** quella versione, quindi il Channel Manager multi-tenant e il
logo introdotti da `713fe0c` **sono rimasti intatti e vanno mantenuti**:
`connettiChannex`, `caricaCamereChannex`, `caricaTariffeChannex`, `syncChannexFull`
e i relativi endpoint (`/api/channex/camere`, `/connetti`, `/tariffe`, `/stato`).

## Cosa c'è ora in gestaway e non va rimosso

### Pagina Prezzi
`page-prezzi`, `renderPrezzi()`, `calcolaPrezziCard()`, `salvaPrezzi()`.
Tutti gli appartamenti in una sola vista, ognuno con prezzi calcolati in tempo reale
e salvataggio indipendente. I campi prezzo **non stanno più** nel modulo appartamento,
che ora contiene solo i dati anagrafici (nome, indirizzo, iCal, SwitchBot, email, note).

### Calendario
- Numero ospiti e nota **prima** del nome, non in coda: `text-overflow: ellipsis`
  taglia dalla fine, quindi un indicatore appeso al fondo è la prima cosa che sparisce.
- Barre `height: 22px`, passo verticale `25px`.
- Nome appartamento come **fascia piena sopra** le barre. Prima era un'etichetta in
  overlay e le prenotazioni che iniziano di lunedì ci finivano sopra, coprendola.

### Questura
- Filtri Tutte / Da registrare / Registrate.
- **"Da registrare" esclude le prenotazioni future**, che prendono il badge
  "Non ancora arrivato": una prenotazione di ottobre non è "in scadenza".
- Elenco degli ospiti già registrati sotto ogni prenotazione.
- Promemoria check-in via `/api/messaggi/invia` (accetta `booking_id`).
- `annullaRegistrato()` per tornare indietro.

### server.js
`/api/prenotazioni` restituisce `numero_ospiti`, contato dalla tabella `ospiti` e
scopato per `struttura_id`. **Senza questo il numero nel calendario resta vuoto.**

### Rimossi di proposito
- Bottone "Rimuovi blocchi": su gestaway chiamava `/api/pulizia/not-available`,
  endpoint che qui non è mai esistito (404 e toast "Rimossi undefined blocchi").
- Blocco "Azioni rapide" nel Channel Manager: duplicava il bottone dell'header.
- Tutte le scritte **"Channex" visibili all'utente**. Le ~23 rimaste sono nomi di
  funzioni e percorsi API: quelle vanno lasciate stare.

## Bug corretti — non reintrodurli

**Update parziali.** `segnaRegistrato` inviava l'intero oggetto prenotazione,
incluso `appartamento_nome` che **non è una colonna** del database: Supabase
rifiutava l'update e l'errore non veniva controllato, quindi l'utente vedeva
"salvato" mentre non era cambiato niente. Regola generale: **inviare solo i campi
che cambiano** e controllare sempre `r?.error`.

**Errori Supabase silenziosi.** `supabase-js` **ritorna** `{ error }`, non lancia
eccezioni. In `channex.js`, se non si controlla l'errore prima di
`acknowledgeBookingRevision()`, Channex considera l'evento consegnato e **non lo
rimanda più**: così si erano perse 3 prenotazioni reali di clienti veri.
Controllare l'errore prima di ogni ack.

**Overbooking.** All'arrivo di una prenotazione nuova bisogna mandare **subito** lo
stop-sell sulle date agli altri canali. Prima si aspettava il sync periodico e nel
frattempo un'altra OTA poteva vendere le stesse notti: è successo davvero
(due ospiti confermati sullo stesso appartamento per l'8-11 ottobre).

### CSS e viste mobile (allineate a cademaricomo, tutte le pagine)

Stesso pattern di regressione del punto sopra: `713fe0c` aveva riportato anche
tutta la parte CSS/mobile a una base vecchia. Corretto di nuovo, questa volta
pagina per pagina su tutto il file:

- **Il blocco `@media (max-width: 768px)` deve restare l'ULTIMO blocco** nel
  `<style>`, subito prima di `</style>`. Se ci finisce qualcosa dopo, quel
  qualcosa vince anche su schermi piccoli a parità di specificità: è la causa
  di quasi tutte le rotture mobile viste finora. **Non aggiungere mai CSS dopo
  quel blocco.**
- `.layout` ha `min-width: 0`. Senza, essendo flex item dentro un flex
  container, non si restringe mai e causa overflow orizzontale su mobile.
  Stessa logica per le griglie: `minmax(0, 1fr)`, mai `1fr` nudo, nelle
  `.form-row`/`.form-row.three`.
- Pattern per ogni vista con layout diverso desktop/mobile: due contenitori,
  uno con classe `.desktop-only` (o `.msg-desktop-only` per Messaggi) e uno
  con `.mobile-only`/`.msg-mobile-only`. Le classi `-mobile-only` sono
  `display:none` di base e diventano `display:block/flex` dentro il blocco
  `@media` finale. **Non usare `window.innerWidth` per nascondere/mostrare via
  JS**: le classi CSS bastano e sopravvivono al resize senza bisogno di
  ridisegnare; `window.innerWidth` va usato solo per **decidere quale dato
  caricare** (es. `loadThreads()`), non per la visibilità.
- **Analitiche**: il selettore è una `<select id="an-metric-select">` con
  `onchange="selezionaMetrica(this.value)"`, non più la sidebar
  `#an-metric-nav` con `.metric-nav-item`. Se `#an-metric-nav` ricompare nel
  file, è di nuovo la versione vecchia.
- **Prenotazioni**: `.table-wrap` ha classe `desktop-only`, più
  `#pren-mobile-list.mobile-only` popolato da `renderPrenotazioni()` con le
  stesse card (`👥` ospiti, `📝` nota, bottone messaggio rapido per
  prenotazioni `channex_`). Occhio: `renderPrenotazioni()` gira solo quando
  la vista è `'lista'` (`setView('lista')`), mai in automatico entrando nella
  pagina (di default è `'calendario'`) — è così anche su cademaricomo, non è
  un bug da "sistemare".
- **Messaggi**: `#msg-iframe-wrap.msg-desktop-only` (iframe Channex) +
  `#msg-mobile-wrap.msg-mobile-only` (inbox custom: lista thread, ricerca,
  chat a schermo intero). `loadThreads()` fa il fetch di
  `/api/messaggi/threads` una volta sola e poi si biforca su
  `window.innerWidth <= 768`: se mobile chiama `renderMobileThreadsList()`,
  se desktop richiede `/api/channex/iframe-token` e monta l'iframe.
  **Importante:** a differenza di cademaricomo (che ha il `property_id`
  fisso nell'URL dell'iframe), gestaway usa `data.channex_property_id`
  restituito dal token endpoint — è multi-tenant, va mantenuto così, non
  tornare all'id fisso copiando cademaricomo alla lettera.
- Rimosso il bottone "🔄 Sincronizza (forza)" di Prenotazioni e la funzione
  `leggiEmailAirbnb()`: chiamava `/api/email/leggi-airbnb`, endpoint mai
  esistito su gestaway (era già stato tolto da cademaricomo su richiesta
  esplicita del cliente mesi fa).

Verificato con Puppeteer (file `_check_full.js`, cancellato dopo l'uso — se
serve ricrearlo, monkey-patchare `window.api` invece di rigenerare mock)
su tutte le 9 pagine a 1280px e 375px: zero errori JS, toggle desktop/mobile
corretto ovunque, inbox mobile Messaggi funzionante end-to-end.

## Abbonamenti Stripe e sospensione struttura (nuovo, non c'era nel giro precedente)

- **`/api/register` è disattivato** (torna 403). Creava strutture `trial` con
  sessione che non scadeva mai e nessun pagamento: era un buco aperto. L'unico
  modo per entrare ora è pagare su Stripe (`/attiva` → checkout → webhook →
  `provisionaStruttura()`), oppure creare la riga a mano in `strutture` +
  `utenti` (caso Cà de' Mari, che non ha Stripe).
- **Nessun piano ha più il trial.** `PIANI_SENZA_TRIAL` includeva prima solo
  `['domus']` lato frontend (`attiva.html`) contro tutti e quattro i piani
  lato backend: mismatch corretto, ora `attiva.html` mostra sempre "Procedi al
  pagamento" e "Addebito immediato", mai più "14 giorni gratis". Se si
  reintroduce un trial, aggiornare **entrambi** i file, non solo uno.
- **Webhook Stripe** ora gestisce, oltre a `checkout.session.completed`:
  `invoice.payment_failed` → `pagamentoFallito()` (stato `in_ritardo`,
  `sospensione_il` = oggi + `GIORNI_TOLLERANZA` (10) giorni, email se
  `SYSTEM_EMAIL_USER`/`PASS` configurate), `invoice.paid`/
  `invoice.payment_succeeded` → `pagamentoRiuscito()` (torna `attivo`,
  `sospensione_il: null`), `customer.subscription.deleted` →
  `abbonamentoDisdetto()` (sospensione immediata, disdetta volontaria).
- **`requireAuth`** (in `server.js`) legge `stato`/`sospensione_il` della
  struttura ad ogni richiesta autenticata, fa scattare da solo il passaggio
  `in_ritardo` → `sospeso` quando la data è passata, e blocca con **402**
  (`{ error, sospeso: true }`) solo se `stato === 'sospeso'`. Fail-open di
  proposito: qualsiasi altro stato (compresi valori imprevisti) passa, così
  un bug nello stato non chiude fuori tutti. `/api/logout` e `/api/sessione`
  restano accessibili anche da sospesi.
  La colonna `sospensione_il` **esiste già** su Supabase, verificato.
- Frontend: l'`api()` wrapper e la UI devono gestire il 402 mostrando il
  blocco "abbonamento sospeso", non trattarlo come un errore generico.

## Onboarding

`ONBOARDING.md` in questo repo è la procedura completa di attivazione di un
cliente nuovo (o della migrazione di Cà de' Mari), scritta leggendo il codice
attuale — se si cambiano i piani, i limiti (`max_strutture_fisiche`) o il
flusso Stripe, va aggiornato insieme al codice, altrimenti si scollega da
quello che il gestionale fa davvero.

## Punti aperti

1. **Bottone unico "Sincronizza tutto"** — non ripristinato. Dipendeva da
   `poll-bookings`, `riallinea-stato` e `verifica-allineamento`, endpoint spariti con
   la riscrittura del Channel Manager. Va ridisegnato sulle API attuali, non rimesso
   identico: rimetterlo com'era significa piazzare un bottone che dà 404.

2. **Colonne mancanti su gestaway.** Il numero ospiti dichiarato in fase di
   prenotazione (non quello registrato in Questura) richiede:
   ```sql
   ALTER TABLE channex_prenotazioni ADD COLUMN IF NOT EXISTS adulti integer;
   ALTER TABLE channex_prenotazioni ADD COLUMN IF NOT EXISTS bambini integer;
   ```
   Finché non esistono, **non** aggiungere `adulti`/`bambini` all'upsert in
   `channex.js`: fa fallire ogni salvataggio di prenotazione (già successo, poi
   annullato).

3. **Airbnb non manda prenotazioni via Channex.** Verificato via API: in tre
   settimane zero prenotazioni Airbnb, solo Booking.com. Il canale risulta attivo con
   token validi. La maggior parte delle prenotazioni arriva ancora dal vecchio sync
   **iCal** (uid `ab_...` / `bk2_...`), che non trasmette il numero ospiti. Channex ha
   l'azione `load_future_reservations` per forzare il caricamento, **ma creerebbe
   doppioni** con le prenotazioni iCal già presenti: non esiste alcun controllo
   anti-duplicato fra le due fonti.

4. **RLS su Supabase** mai verificata (difesa in profondità).

## Sito gestaway.com

Le anteprime nella sezione "Anteprima" sono generate dal gestionale allineato, con
dati finti e nomi di sola battesimo. Se si cambia la UI del gestionale, **vanno
rigenerate**, altrimenti il sito pubblicizza funzioni che il prodotto non ha.
Lo screenshot del calendario va fatto **filtrato su un solo appartamento**: con tre
il mese diventa alto 2152px e sul sito (immagini a tutta larghezza) viene tagliato.

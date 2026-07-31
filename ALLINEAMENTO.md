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

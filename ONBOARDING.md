# Attivazione di un nuovo cliente su Gestaway

Procedura completa per portare una struttura da zero a operativa. Vale sia per un
cliente nuovo sia per la migrazione di Cà de' Mari dal gestionale dedicato.

Legenda: **[auto]** avviene da solo · **[noi]** lo facciamo noi · **[cliente]** serve
un'azione o un dato del cliente.

---

## 1. Account e accesso

| | Operazione | Note |
|---|---|---|
| **[auto]** | Pagamento su Stripe → creazione struttura e utente | Il webhook chiama `provisionaStruttura()`: crea la riga in `strutture` (nome, email, CIN, piano, `max_strutture_fisiche`) e l'utente `owner` in `utenti` |
| **[auto]** | Email di benvenuto con password temporanea | Parte solo se `SYSTEM_EMAIL_USER` e `SYSTEM_EMAIL_PASS` sono configurate sul server. **Se non lo sono, il cliente non riceve nulla e resta bloccato fuori**: verificarlo prima di ogni attivazione |
| **[cliente]** | Primo accesso su `/gestionale` e cambio password | |

Il piano determina quante strutture fisiche può creare: base 1, professionale 3,
personalizzato illimitate. Se il cliente ne aggiunge oltre il limite riceve un
errore esplicito.

**Migrazione Cà de' Mari:** qui non c'è pagamento Stripe, quindi struttura e utente
vanno creati a mano nelle due tabelle, replicando esattamente quello che farebbe
`provisionaStruttura()`.

---

## 2. Appartamenti

**[cliente/noi]** Per ogni unità, da *Appartamenti → + Aggiungi*:

- nome e indirizzo
- link iCal Airbnb e Booking.com (se li usa già — vedi nota sotto)
- Device ID SwitchBot, se ha la serratura smart
- email del proprietario

> **Attenzione ai doppioni.** Se il cliente collega **sia** gli iCal **sia** i canali
> via Channex, la stessa prenotazione entra due volte: una come `ab_`/`bk2_` e una
> come `channex_`. Non esiste oggi un controllo anti-duplicato. Decidere **una sola**
> fonte per canale: se il canale è collegato a Channex, non mettere il suo iCal.

---

## 3. Prezzi

**[cliente/noi]** Da *Prezzi*, per ogni appartamento:

- prezzo base netto per notte (quello che il cliente vuole incassare)
- IVA
- rincaro sito, mark-up Airbnb, mark-up Booking
- rincari per bassa / media / alta stagione

I prezzi finali per canale e stagione si vedono calcolati sotto ai campi. Ogni
appartamento si salva singolarmente.

---

## 4. Collegamento ai canali (Channex)

Da *Channel Manager*:

1. **[noi]** *Collega ad Airbnb / Booking.com* → crea la property su Channex e la
   riga in `channex_mappings` con lo `struttura_id`. Invita anche l'account admin
   Gestaway a vedere la property nel pannello Channex.
2. **[noi]** Creare le **camere** (room types) — una per appartamento.
3. **[noi]** Creare le **tariffe** (rate plans) collegate alle camere.
4. **[cliente]** Collegare i suoi account Airbnb e Booking.com dal pannello Channex
   (serve il login del cliente, non possiamo farlo noi).
5. **[noi]** *Sincronizza tutto* e verificare che le disponibilità arrivino sui portali.

> **Verifica indispensabile prima di dire che è pronto:** fare una prenotazione di
> prova su un canale e controllare che compaia nel calendario. Se il mapping non è
> corretto le prenotazioni arrivano, non trovano la struttura e **vengono scartate
> silenziosamente**. È già successo e sono sparite tre prenotazioni reali.

---

## 5. Impostazioni della struttura

**[cliente]** deve fornire le credenziali, **[noi]** le inseriamo da *Impostazioni*:

| Sezione | Campi | Serve per |
|---|---|---|
| Dati per Ricevute | ragione sociale, indirizzo, telefono, email, codice fiscale | generare le ricevute |
| Alloggiati Web | username, password, codice struttura (WS) | invio schedine alla Questura |
| Ross1000 | codice struttura, username, password | statistiche regionali (solo Lombardia) |
| Email Gmail | indirizzo e **App Password** | invio messaggi e ricevute |
| SwitchBot | token e secret | apertura serratura da remoto |
| Messaggi automatici | interruttore on/off | conferma, pre-arrivo, check-out |

Per Gmail serve una **App Password**, non la password normale: il cliente la genera
da *Account Google → Sicurezza → Verifica in due passaggi → Password per le app*.
È il punto in cui più spesso si bloccano: conviene spiegarlo in anticipo.

**Messaggi automatici:** lasciarli spenti se il cliente usa già quelli di
Booking/Airbnb, altrimenti l'ospite riceve due volte le stesse comunicazioni.

---

## 6. Check-in online

**[noi]** Verificare che la pagina di check-in risponda e che i dati inseriti
dall'ospite finiscano nella prenotazione giusta.
**[cliente]** Decidere se mandare il link a mano o lasciare che parta con i
messaggi automatici.

---

## 7. Collaudo prima della consegna

Da fare **sempre**, prima di dire al cliente che può iniziare:

- [ ] Il cliente riesce ad accedere e ha cambiato la password
- [ ] Una prenotazione di prova da un canale compare nel calendario
- [ ] La disponibilità inviata dal gestionale si vede sul portale
- [ ] Un check-in online di prova arriva sulla prenotazione corretta
- [ ] Il file Alloggiati Web viene generato senza errori
- [ ] I prezzi calcolati corrispondono a quelli attesi dal cliente
- [ ] Se la struttura è in Lombardia: l'XML Ross1000 si scarica

---

## 8. Cosa dire al cliente alla consegna

- Dove accede e con quali credenziali
- Che la Questura va comunque controllata: il sistema **genera e invia** il file, ma
  la responsabilità della registrazione entro 24h resta sua
- Che se cambia i prezzi dal gestionale questi vanno sui canali, non viceversa
- A chi scrivere per assistenza

---

## Punti aperti che toccano l'onboarding

1. **Airbnb non consegna prenotazioni via Channex.** Verificato su Cà de' Mari: in
   tre settimane zero prenotazioni Airbnb via Channex, solo Booking.com. Finché non
   è risolto, per Airbnb serve l'iCal — che però non porta il numero ospiti e non
   segnala le cancellazioni.
2. **Le cancellazioni via iCal non vengono rilevate.** Se una prenotazione sparisce
   dal feed resta "confermata" nel gestionale. Da implementare il confronto fra
   sync successivi.
3. **Nessun controllo anti-duplicato** fra prenotazioni iCal e Channex (vedi §2).
4. **Chiave API Channex condivisa** fra tutte le strutture: chi ha accesso al server
   ha accesso a tutte le property.

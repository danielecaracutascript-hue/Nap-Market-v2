# Verifica Next locale — 30 ottobre 2026

`scripts/prepare-browser-preview.mjs` prepara una copia ignorata dei soli sorgenti
committati in `C:\progetti\work\integration-local\browser-preview-*`. Richiede lo
stack Supabase sintetico già avviato e identificato. Non copia `.env`, backup,
runtime wallet o il prototipo V2. Usa le dipendenze installate tramite junction.
Avvia Next su `127.0.0.1:3100` con ambiente esplicito, credenziali esclusivamente
del Supabase locale e RPC del nodo Regtest in sola lettura. Non avviare una seconda
copia mentre questa porta è occupata.

La copia contiene tre differenze intenzionali: font locale di ripiego, accesso
fittizio `/auth/integration-login` senza password/email inviate, endpoint submit
release/refund sostituiti da risposte 503. La route di accesso non viene aggiunta
all'applicazione originale. Chi può accedere alla porta locale può usare gli
utenti sintetici: questa copia serve solo per sviluppo locale.

La fixture `tests/fixtures/local-browser-checkout.sql` estende soltanto il database
contrassegnato di integrazione con campi e relazioni richiesti dalle pagine. Non
è una migrazione di produzione né uno schema completo. Gli indirizzi sono finti.
Gli indici escrow partono da 100000: non usare questa copia per preparare pagamenti.

`node marketplace/tests/local-next-checkout.mjs` controlla HTTP Next e richieste
reali Auth/PostgREST: sessioni SSR, checkout, indirizzo, preventivo, creazione ordine,
query del dettaglio, elenco con relazione annuncio, lettura venditore, ripetizione
respinta e submit disabilitati. Se l'ordine della fixture esiste già, lo recupera
senza crearne un altro; il report indica `creationPerformed`. Conserva i dati
sintetici e scrive soltanto metadati pubblici nel report ignorato.

Risultato: creazione reale iniziale riuscita; prima esecuzione fermata da
un'aspettativa del test errata sul nome interno del componente nella risposta
HTML. Corretta l'aspettativa usando l'ID pubblico dell'ordine, seconda esecuzione
completata con 26 controlli. Query ordine/eventi/recensioni/dispute e lista con
titolo eseguite realmente; nessuna operazione Bitcoin. La fixture iniziale è stata
completata con `order_events.created_at`, richiesto dal componente.

Browser integrato e Computer Use non avviabili: entrambi riportano
`failed to write kernel assets` / percorso non trovato, anche dopo reset del
browser. Non effettuata verifica visiva o esecuzione degli effetti React in un
browser. Il test HTTP non sostituisce questa parte né una build di produzione.

Compilando la pagina ordine, Next segnala la dipendenza opzionale mancante
`@ledgerhq/ledger-bitcoin`, importata transitivamente da
`@bitcoinerlab/descriptors` tramite `lib/wallet.ts`. Le risposte HTTP sono 200;
supporto Ledger e dimensioni/comportamento del bundle client restano da esaminare.
Non aggiunte dipendenze o modificate funzioni wallet per sopprimere l'avviso.

Prossimi passi: completare la prova visiva quando il browser torna disponibile,
verificare gli errori di rete nel flusso reale React, chiarire il supporto Ledger
prima della build isolata e continuare il censimento dello schema remoto. Legacy,
ordini finanziati e dati reali non toccati.

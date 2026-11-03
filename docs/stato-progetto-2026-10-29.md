# Stato Nap Market — 29 ottobre 2026

## Punto di ripresa per il 30 ottobre

Lavoro sospeso per oggi su richiesta dell’utente. Riprendere dalla revisione selettiva delle modifiche Git e dalla preparazione di un controllo integrato delle nuove API in ambiente isolato. Non ripetere automaticamente i test già passati. Non effettuare firme, finalizzazioni o trasmissioni Bitcoin, e non leggere mnemonic, password, chiavi private o file di credenziali.

Progetto Codex: Nap Market. Radice Git C:\progetti; app C:\progetti\marketplace. Il checkout nap-market-fix non è il progetto modificato e non va sovrascritto o unito automaticamente.

## Risultato della giornata

Siamo nella fase di consolidamento della sicurezza del prototipo Next.js/Supabase. Il marketplace non è stato certificato per l’uso con Bitcoin reali e non è stato completato il ciclo Escrow V2.

La prima firma ECDSA buyer V2 su Regtest era già passata prima di questa revisione ed è rimasta acquisita. Non è stata ripetuta. Nessuna firma reale, finalizzazione o trasmissione è stata eseguita durante questo lavoro.

## Correzioni locali applicate

- Protezione server-only dei moduli RPC Bitcoin, client amministrativo Supabase e preview V2.
- Correzione dei tre letterali bigint incompatibili con il target TypeScript e dell’import inutilizzato nella pagina di test V2.
- Unicità delle chiavi V2 confrontata sul tpub, indipendentemente dal fingerprint dichiarato.
- Sospensione di pay-from-wallet, che usava il wallet Core condiviso buyer, assumeva vout=0 ed eseguiva invii/mining. Route ora 503 e pulsante sostituito da spiegazione. Nessun cambiamento agli ordini già finanziati.
- Check-payment con validazioni più rigorose: pagamenti eccedenti o su più output sono visibili come casi da revisionare e non vengono marcati automaticamente FUNDED con importi incompatibili col legacy.
- Rilascio/rimborso ricavano le chiavi pubbliche originarie dal descriptor completo salvato, invece dei profili o delle chiavi pubbliche correnti. Il browser verifica il wallet originario prima dello sblocco. Descriptor sconosciuti vengono fermati per revisione.
- Ricevute con TXID distinguono invio noto da esito incerto; la sessione del browser conserva solo dati pubblici e blocca il secondo tentativo.
- Coordinamento persistente per ordine e funding outpoint: una sola richiesta può ottenere il tentativo. Esiti incerti, crash e risposte perse non liberano automaticamente la prenotazione.
- Riconciliazione con sole letture Bitcoin: rete di prova configurata, blocco attivo confermato, TXID, bozza, funding reale/script/indirizzo/valore, destinazioni, commissioni e fee. Nessuna prova positiva significa nessuna riconciliazione e nessuno sblocco.
- Normale registrazione dopo l’ACK e riconciliazione usano la stessa funzione SQL atomica. Riutilizzano le funzioni legacy sotto lock e non duplicano eventi. Una snapshot protegge da cambi di ordine/PSBT durante la verifica. Le PSBT confermate non vengono degradate.
- Pulsante Check transaction status nella pagina ordine, senza accesso al wallet, firma o invio.

## SQL eseguita dall’utente su Supabase e riscontri ricevuti

1. confirm_payment: accesso EXECUTE revocato a PUBLIC/anon/authenticated e riservato al servizio. Riscontro anon=false, authenticated=false, service_role=true. Il corpo precedente poteva segnare un ordine FUNDED senza verifica del chiamante/pagamento; non va richiamato dal client.
2. confirm_delivery: corpo corretto con auth.uid obbligatorio, buyer_id corrispondente e stato SHIPPED; conserva FOR UPDATE e finestra di 14 giorni. Definizione aggiornata e permessi restituiti dall’utente.
3. add-escrow-submission-claims.sql: nuova tabella e funzione server-only. Riscontro tabella esistente, execute solo service_role, letture pubbliche negate.
4. add-escrow-reconciliation.sql: nuova funzione server-only a sei parametri (due opzionali), usata per ACK e conferma. Dopo un errore iniziale di copia nell’editor l’utente ha eseguito il file completo; riscontro anon=false, authenticated=false, service_role=true.

L’installazione di questi script non chiama le funzioni applicative e non modifica righe di ordini esistenti. Non è stata eseguita una riconciliazione su ordini reali da questa sessione. Per la funzione corrente vedere il file SQL nel progetto, non vecchie copie della chat.

## Verifiche completate

- TypeScript --noEmit --incremental false e ESLint sui file modificati passano.
- 62 scenari offline per le route di invio: firma, finalizzazione e broadcast sono stub inerti.
- 40 casi di prova su dati pubblici sintetici (6 positivi, 34 negativi), con risposte Core simulate. Nessuna generazione di seed o chiavi private.
- 20 scenari per la nuova API di riconciliazione, con autorizzazioni e divieto di scritture senza prova.
- 18 scenari browser/ricevute, incluso controllo dello stato senza wallet.
- Regressioni legacy: struttura del descriptor, stabilità dei payout dopo cambio chiavi, quattro route, conservazione delle bozze e rifiuto delle policy sconosciute.
- 24 verifiche reali su PostgreSQL 17.10 locale isolato: concorrenza tra connessioni, unicità dell’outpoint, rollback, disconnessioni, riavvio, privilegi senza superuser/BYPASSRLS, riconciliazione idempotente, eventi singoli, errori forzati, snapshot stale e corsa ACK/conferma. Provate signed_by come SQL array e JSONB.
- Le funzioni legacy sono test double nel database isolato, non copie delle definizioni Supabase attive. Il wrapper conserva le funzioni installate senza riscriverle.
- Il server PostgreSQL temporaneo è stato fermato. Runtime, cluster sintetici e report restano in C:\progetti\work\pg-validation; download/cache e scratch sono ignorati da Git. Nessuna dipendenza applicativa è stata installata o aggiornata da questi test.

## Limiti ancora aperti

- Non è stata eseguita una prova integrata delle nuove API con Supabase/PostgREST e Bitcoin Core reali. Nessun accesso al nodo, cookie RPC o wallet reale è stato effettuato dai test.
- Manca una baseline completa e versionata dello schema Supabase: supabase-schema.sql locale era vuoto; abbiamo definizioni/metadati parziali forniti dall’utente.
- Il recupero non trasmette mai: una prenotazione senza prova positiva resta bloccata per revisione, anche dopo un crash prima dell’invio.
- La verifica richiede almeno una conferma sulla catena attiva e non monitora riorganizzazioni successive.
- Reti supportate dalla riconciliazione: regtest, signet, testnet legacy; mainnet e testnet4 rifiutate. La rete configurata deve corrispondere alla rete di funding. Le prenotazioni legacy non fissano ancora un identificatore immutabile di rete/genesis; signet/testnet condividono il formato degli indirizzi.
- Pagamenti eccedenti, frazionati o tardivi richiedono ancora un percorso operativo di revisione; non è stata eseguita una migrazione degli ordini finanziati.
- V2 resta separata dal ciclo ordini e contiene una pagina di test con parametri fissi. Seconda firma indipendente e ciclo completo non completati; nessuna autorizzazione a finalizzare o trasmettere è implicita nella ripresa.
- Versioni latest e disallineamento Next/eslint-config-next da affrontare in una modifica distinta, senza toccare alla cieca le modifiche esistenti al lockfile.

## Git e conservazione del lavoro

Le modifiche sono salvate localmente ma non committate. Package.json, package-lock.json, lib/escrow.ts.bak, backup e numerosi file V2 non tracciati erano già presenti/modificati all’inizio; non vanno confusi con le nuove correzioni o aggiunti in blocco. Nessun reset, pulizia, commit, push o merge è stato eseguito. Non includere .env, materiale wallet, tmp-escrow-test o altri file non revisionati.

Dettagli tecnici: docs/escrow-submission-coordination.md. Script SQL: supabase/security/. Test riproducibili: tests/. I file SQL in tests/fixtures sono esclusivamente per il database sintetico e non vanno installati su Supabase.

## Piano operativo per domani

1. Rileggere questo riepilogo e controllare solo le differenze Git rispetto a oggi; conservare modifiche dell’utente e altri checkout.
2. Consolidare selettivamente codice, test e SQL revisionati in una baseline sicura, senza segreti o materiale di test wallet.
3. Preparare e verificare l’integrazione delle nuove API in un ambiente isolato, mantenendo firme/finalizzazione/invio disattivati e senza leggere credenziali dell’utente. Distinguere chiaramente test reali e servizi simulati.
4. Completare inventario delle funzioni/policy ancora non revisionate e percorso per i pagamenti che richiedono revisione.
5. Riprendere la progettazione dell’integrazione V2 solo sui nuovi ordini, preservando gli escrow finanziati. Non ripetere la prima firma già verificata.

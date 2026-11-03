# Ambiente di integrazione locale Nap Market

Ambiente nuovo per verificare Supabase/PostgREST e Bitcoin Core reali con dati
sintetici. Non collegare il progetto Supabase remoto, non importare ordini o wallet
esistenti e non leggere le configurazioni applicative contenenti credenziali.

## Stato della preparazione

Il 30 ottobre 2026 l'utente ha scelto di preparare Docker Desktop locale.
Windows 11 Pro build 26200, architettura 64 bit, circa 16 GB RAM; hypervisor
presente. I flag CPU di virtualizzazione restituiti dal sistema sono falsi:
la possibilità di avviare WSL2 va verificata dopo l'installazione, senza dedurre
da questi soli flag che il BIOS richieda modifiche.

Docker Desktop, Supabase CLI e Bitcoin Core non trovati nel PATH o nelle
posizioni Docker/Bitcoin controllate. WSL inizialmente non installato.
Pacchetti ufficiali rilevati tramite winget: Microsoft.WSL 2.7.14 e
Docker.DockerDesktop 4.97.0. L'installazione WSL non elevata è fallita con
0x80073d28 (necessari privilegi amministrativi). Avviato poi lo script
scripts/install-local-wsl.ps1 tramite conferma amministrativa Windows.
Non riavvia automaticamente e non installa una distribuzione Linux.
Log/esito esclusivamente del setup in C:\progetti\work\integration-local.

Aggiornamento: WSL installato e versione 2.7.14.0 verificata, kernel
6.18.33.2-2. Il primo script aveva riportato errore su un messaggio transitorio
di stderr durante l'aggiornamento; il successivo controllo della versione è
riuscito. VirtualMachinePlatform risulta abilitato. Docker Desktop 4.97.0
installato per utente con backend WSL2; motore locale e client rispondono
29.9.2. CLI Supabase 2.122.0 installata solo in work/integration-local/tools,
senza modifiche alle dipendenze del marketplace. Nessun riavvio effettuato.

Inizializzato progetto locale con project_id nap-market-isolated-20261030;
nessun login o link a Supabase remoto. Avvio del sottoinsieme PostgreSQL,
GoTrue, PostgREST e Kong in corso, servizi non necessari esclusi. Il primo
tentativo non trovava Docker nel PATH della sessione precedente all'installazione;
corretto usando il percorso installato e DOCKER_HOST esplicito sul pipe locale.
Script riproducibile scripts/start-local-integration.ps1. Il log di avvio può
contenere credenziali generate esclusivamente per questo ambiente e non va
mostrato o aggiunto a Git. Non confondere questo avvio con un test completato.

Primo avvio completato con codice 0. Verificati Auth HTTP 200, PostgREST HTTP
200 e PostgreSQL 17.11 nel contenitore dedicato. Rilevato che la configurazione
iniziale pubblicava 54321/54322 su tutte le interfacce: stack fermato con backup
dei volumi, creata rete nap-market-isolated-loopback con opzione
com.docker.network.bridge.host_binding_ipv4=127.0.0.1, riavvio sulla nuova rete.
Lo script start ora rifiuta una rete priva di questa impostazione.

Bitcoin Core 32.1 scaricato come ZIP dal sito ufficiale ed estratto soltanto
nella cartella scratch. SHA256 confrontato con SHA256SUMS ufficiale, uguale;
non effettuata verifica GPG delle firme dei manutentori. Il primo download via
Invoke-WebRequest non trasferiva dati ed è stato interrotto; download curl con
timeout riuscito. Nessuna installazione sul wallet personale.

Avviato nodo dedicato con scripts/start-local-regtest-readonly.ps1, directory
nuova marcata regtest-readonly, porta RPC 19443 su loopback, disablewallet=1,
networkactive=0/listen=0/dnsseed=0/discover=0. RPC whitelist dell'utente cookie
limitata a getblockchaininfo/getnetworkinfo/getrpcinfo/stop. Il programma CLI
usa internamente soltanto il cookie nuovo di questo nodo; nessun cookie,
wallet o chiave dell'utente è letto o mostrato. Verificati chain=regtest,
blocks=0, networkactive=false e connections=0. Nessun blocco generato o
transazione firmata/finalizzata/trasmessa. Il nodo non è ancora configurato
per la prova del ciclo escrow: non abilitarne wallet o RPC mutanti implicitamente.

Esito definitivo porte: la sola opzione di rete non era sufficiente, perché
Supabase CLI pubblica esplicitamente su tutte le interfacce. Stack nuovamente
fermato con volumi preservati. Aggiunto launcher locale Docker compilato da
scripts/local-docker-loopback.cs in work/integration-local/loopback-bin/docker.exe:
riscrive solo --publish/-p verso 127.0.0.1, rifiuta publish-all e formati non
supportati, inoltra gli altri argomenti senza shell expansion o registrazione.
PATH limitato al processo di avvio Supabase, nessuna modifica a Docker globale
o al PATH Windows permanente. La prima versione non inoltrava gli stream,
corretta e poi verificata con --version e avvio reale.

Verificato via docker ps dopo il nuovo avvio: Kong 127.0.0.1:54321->8000,
PostgreSQL 127.0.0.1:54322->5432; nessun bind 0.0.0.0 o IPv6 pubblico nei
quattro contenitori di questo stack. Auth/PostgREST interni alla rete Docker.
Il controllo è sui binding dichiarati da Docker, non una scansione da un altro
PC. Servizi lasciati avviati per la successiva prova con dati sintetici.

Stato finale: infrastruttura locale preparata e verificata; test completo di
ordine/escrow con API reali ancora da implementare/eseguire. Non modificati
.env, package.json o package-lock.json dell'app, wallet o ordini reali.

## Prova dei flussi con Supabase reale — 30 ottobre

Eseguito `node marketplace/tests/local-supabase-orders.mjs`: 15 controlli
passati con GoTrue, PostgREST, PostgreSQL e SDK reali locali. Usati le factory
Supabase server/admin, i route handler escrow/check-payment e NextResponse
reali, caricati isolatamente senza avviare Next né leggere .env.
Il contesto request di next/headers è un adattatore in memoria; serializzazione
e lettura delle sessioni tramite @supabase/ssr e verifica utente via Auth reali.
Non è una verifica browser/Next middleware completa.

Il runner forza API 127.0.0.1:54321 e pipe Docker locale, verifica nomi dei
contenitori e binding non pubblici, poi installa soltanto nel progetto nuovo
uno schema minimale sintetico con marker. La fixture si ferma se trova una
orders preesistente senza marker; mai installarla sul database remoto. Usa le
due nuove RPC revisionate e copie della logica legacy ricevuta nell'audit su
tabelle sintetiche. Le policy RLS sono sintetiche, non l'intero schema attivo.

Utenti locali creati via generateLink e verifyOtp senza password né invio email,
indirizzi example.test casuali. Auth può restituire tipo signup per un nuovo
utente anche se la richiesta era magiclink: il test ora usa verification_type
restituito dal server. Credenziali/API key/token generati dal solo stack locale
usati internamente dal runner, mai stampati. Nessuna credenziale utente reale.

Copertura: assenza sessione, buyer/seller/estraneo, creazione escrow consentita
solo buyer, ripetizione senza nuova generazione/evento, snapshot prezzo cambiata
respinta, risposta persa dopo COMMIT reale con successivo controllo idempotente,
permessi SQL 42501 per entrambi i client anon/authenticated su entrambe le RPC.
Report senza credenziali in work/integration-local/orders-integration-report.json.
Utenti e ordini sintetici conservati solo nel database locale, nessuna pulizia
automatica di dati o volumi.

Bitcoin: risposte di creazione e funding sono stub inerti. Nessuna chiamata
reale a importdescriptors/getnewaddress/listunspent per questo test; nessun
pagamento reale generato. Il nodo Core reale è interrogato soltanto con
getblockchaininfo e getnetworkinfo: regtest, zero blocchi/peer, rete P2P inattiva.
Resta da progettare una prova della componente blockchain compatibile con il
divieto di firma/finalizzazione/broadcast; non dichiarare questo test un
ciclo escrow completo né ripetere la prima firma V2.

## Descriptor e indirizzi con Core reale

Estesa la whitelist del solo nodo Regtest dedicato con getdescriptorinfo,
deriveaddresses e validateaddress: tutte operazioni sui dati pubblici, senza
wallet, mining o transazioni. Il nodo è stato fermato e riavviato con gli stessi
vincoli networkactive=0/disablewallet=1. Non aggiunte RPC di firma/finalizzazione/
broadcast né accesso al wallet Core dell'utente.

Passati 11 controlli `tests/local-core-descriptors.mjs` su Core 32.1 reale:
descriptor legacy risolvibile, ranged e privo di materiale privato; policy
normalizzata compatibile col parser; indirizzi e script agli indici 0,42,10000
uguali a quelli derivati con la libreria effettivamente usata dall'app; indirizzi
distinti e catena sempre a zero blocchi/peer. Solo punto pubblico e chain code
sintetici, nessuna generazione di seed/chiavi private. Report pubblico
work/integration-local/core-descriptor-report.json.

Aggiornata la prova `local-supabase-orders.mjs` per usare getdescriptorinfo e
deriveaddresses REALI nella route di creazione escrow. Passati nuovamente i
15 scenari con Auth/cookie SSR/PostgREST/SQL reali e indirizzo bcrt1 del Core
reale salvato sull'ordine sintetico. Restano stub watch import, indirizzo shipping
ed evidenza UTXO/pagamento; contesto cookie Next adattato in memoria. Nessuna
prova di fondi reali o del ciclo completo di settlement. Lint e sintassi passano;
nessun cambiamento applicativo o SQL remoto necessario per questo passo.

Successivamente aggiornate le route per confrontare la rete dichiarata da Core
con la configurazione dell'app prima di nuova creazione/funding. Il runner
locale usa NEXT_PUBLIC_BITCOIN_NETWORK=regtest sintetico e getblockchaininfo
reale: i 15 scenari continuano a passare. Testnet legacy e signet hanno nomi
chain distinti anche se condividono i formati degli indirizzi; app configurata
signet ora deriva i payout pubblici con bitcoinjs.networks.testnet.
Nessuna modifica alla configurazione effettiva del marketplace o ai suoi .env.

## Ciclo spedizione, consegna e reso su Supabase reale

Eseguito `node marketplace/tests/local-supabase-orders.mjs --lifecycle`:
15 scenari iniziali di creazione/funding di test e 38 controlli aggiuntivi
con GoTrue/PostgREST/PostgreSQL reali locali. Il nuovo modulo
tests/local-supabase-lifecycle.mjs riusa utenti e ordine sintetici del runner,
carica la fixture locale dedicata e gli script confermati fix-confirm-delivery
e fix-shipping-inputs. Per confirm_receipt/request_return/confirm_return_received
la fixture contiene i corpi ricevuti nell'audit; patch applica solo search_path.

Provato percorso FUNDED -> SHIPPED -> DELIVERED -> RETURN_REQUESTED ->
RETURN_SHIPPED -> REFUNDED, con normalizzazione tracking, identità degli attori,
evento singolo per passaggio, finestre 14/7 giorni e inserzione nuovamente active.
REFUNDED indica approvazione commerciale del rimborso, non pagamento Bitcoin.
Provato anche DELIVERED -> COMPLETED con inserzione sold. Input NULL,
partecipanti sbagliati/estranei/anonimi, stati/scadenze errati e ripetizioni
non modificano snapshot ordine/inserzione/eventi.

Due corse reali via HTTP: confirm_receipt contro request_return sullo stesso
ordine, e doppia confirm_return_received. In entrambi i casi una sola richiesta
riesce, l'altra viene respinta e si registra un solo evento.

Limiti: schema minimale sintetico esteso soltanto per i campi necessari;
non replica tutti i vincoli, FK e indici della produzione (in particolare i
vecchi ordini sintetici possono riusare indici escrow). Non è migrazione dello
schema completo né prova UI/browser. Utenti/ordini rimangono solo nello stack
locale; nessuna pulizia automatica, nessun ordine remoto usato. Il ciclo
commerciale non richiama Bitcoin. Nel preambolo restano simulate le evidenze
di funding e le operazioni wallet, come documentato sopra.

Report senza credenziali: work/integration-local/lifecycle-integration-report.json.
Lint, sintassi e diff passati; nessun SQL da installare sul progetto remoto.

## Dispute e arbitri su Supabase reale

Eseguito `node marketplace/tests/local-supabase-orders.mjs --disputes`:
15 scenari iniziali e 45 verifiche dispute con GoTrue/PostgREST/RLS/PostgreSQL
reali locali. Nuovi modulo e fixture: local-supabase-disputes.mjs e
fixtures/local-supabase-disputes.sql, da usare soltanto col runner protetto.
Installati localmente i due script open/decide revisionati; helper arbitro e
policy SELECT riproducono le condizioni ricevute nell'audit. Lo schema resta
minimale e non equivale all'intero schema remoto.

Coperti: buyer/seller esclusi dall'assegnazione anche se presenti come arbitri
attivi, arbitro inattivo escluso, letture di ordine/disputa/eventi consentite
alle parti e all'assegnato ma negate all'estraneo e all'arbitro non assegnato;
scrittura diretta per autoproclamarsi arbitro bloccata da RLS. Decisioni buyer
e seller aggiornano stati/listing/eventi/contatore, input NULL e ripetizioni
respinti senza mutazioni. Reso contestato dal seller e vinto dal buyer conserva
la commissione buyer, calcolata con l'helper effettivo dell'app.

Due decisioni opposte simultanee via HTTP: una sola riesce, un solo evento e
un incremento contatore. Senza arbitro indipendente disponibile la disputa
resta open e l'ordine DISPUTED, senza attribuzione alle parti; nessuna decisione
consentita a un arbitro non assegnato. Questo NON verifica un servizio successivo
di riassegnazione: non è stato implementato o eseguito in questi test.

Per riproducibilità il runner disattiva i vecchi candidati della sola tabella
arbiters sintetica, conservando righe/contatori; alla fine disattiva anche i
nuovi candidati. Nessuna modifica a utenti o arbitri reali. I nuovi utenti sono
locali/passwordless, nessuna email inviata. Report senza credenziali in
work/integration-local/dispute-integration-report.json. Nessun Bitcoin nel ciclo
dispute; nel preambolo evidenze funding/wallet rimangono simulate. Lint/sintassi
e diff passati, nessun SQL nuovo da eseguire sul database remoto.

## Sequenza di completamento

1. Confermare installazione WSL e stato dei componenti Windows. Un eventuale
   riavvio è un'azione manuale dell'utente; salvare prima il lavoro.
2. Installare Docker Desktop ufficiale, preferibilmente per utente e con WSL2.
   Primo avvio e condizioni Docker nell'interfaccia utente; nessun account
   del marketplace o dato finanziario necessario.
3. Verificare Docker engine e creare una directory nuova sotto
   C:\progetti\work\integration-local, con identificatore progetto separato.
4. Installare una versione fissata di Supabase CLI nel solo ambiente scratch,
   senza modificare package.json/package-lock.json del marketplace. Inizializzare
   localmente, senza login/link/db pull/push verso Supabase remoto.
5. Preparare schema sintetico con le definizioni SQL revisionate; eseguire
   PostgREST e Auth locali. La baseline completa dell'app non esiste ancora:
   distinguere il test dei percorsi finanziari dalla migrazione dell'intero sito.
6. Preparare un nodo Core Regtest dedicato, con directory e porte nuove,
   nessun mount di wallet/cookie reali e nessuna connessione a nodi pubblici.
   In questa sessione resta vietato firmare, finalizzare o trasmettere transazioni,
   anche per completare la prova. Non ripetere la prima firma V2.
7. Avviare la prova soltanto con destinazioni locali verificate, dati sintetici
   e nessun endpoint che possa eseguire firma/finalizzazione/broadcast. Se serve
   funding, progettare una fixture compatibile con tali vincoli prima di usarla.

La prova reale non è ancora eseguita. I precedenti test HTTP con adattatore
simulato non equivalgono a PostgREST/Auth/Core reali.

## Documentazione ufficiale consultata

- https://docs.docker.com/desktop/setup/install/windows-install/
- https://learn.microsoft.com/en-us/windows/wsl/install
- https://learn.microsoft.com/en-us/windows/wsl/basic-commands
- https://supabase.com/docs/guides/local-development/cli/getting-started

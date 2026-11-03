# Baseline da consolidare

Stato al 30 ottobre 2026: consolidamento selettivo sul ramo
`codex/marketplace-consolidation-20261030`. Non confondere questi commit con
un rilascio o con una baseline completa del database.

## Perimetro delle correzioni revisionate

- API orders: creazione escrow, check-payment, sospensione pay-from-wallet,
  release/refund prepare/submit, nuova settlement/reconcile.
- Interfacce: dettaglio ordine e relativa pagina server, pagina arbitro,
  checkout con preventivi associati alla selezione.
- Moduli: bitcoin.ts (server-only/signal), supabase/admin.ts (server-only),
  escrow.ts (chiavi legacy/rete signet/commento policy), bitcoin-test-network,
  escrow-legacy-policy, escrow-preparation, escrow-receipt,
  escrow-reconciliation, escrow-settlement, escrow-submission.
- Script SQL sotto supabase/security: distinguere patch installate,
  query di audit e script in attesa. I riscontri sono nel riepilogo giornaliero.
- Test/fixture e documentazione creati durante la revisione: fixture soltanto
  sintetiche, mai da installare remotamente.
- Script runtime locale: install-local-wsl, start-local-integration,
  start-local-regtest-readonly e launcher Docker loopback. Sono specifici del
  PC e dell'ambiente di prova, da valutare come commit separato dalle correzioni.
- .gitignore alla radice: esclusione /work/ per runtime, cluster e log locali.

## Da mantenere separato

- package.json e package-lock.json avevano modifiche preesistenti: nessun
  riallineamento/aggiornamento dipendenze effettuato automaticamente.
- File V2 e relativa pagina di test preesistevano non tracciati; alcune correzioni
  sono documentate, ma richiedono revisione dedicata prima di includere tutto.
- .bak, pre-fix/pre-network-fix e copie phase*, reset-arbitro.cjs,
  tmp-escrow-test, altro checkout nap-market-fix e file anomalo alla radice:
  non aggiungere né eliminare in blocco.
- .env, credenziali, wallet, mnemonic, password, chiavi private e contenuti
  work/ non devono essere inclusi nella baseline o consultati per consolidarla.
- supabase-schema.sql era vuoto: non presentarlo come schema ricostruito.

## Criteri della revisione e dei commit

1. Usare le definizioni ricevute dall'audit checkout e i relativi test;
   distinguere sempre schema sintetico da schema completo remoto.
2. Rileggere differenze e dipendenze per i soli file del perimetro; elencare
   esplicitamente ogni file nuovo, evitando git add su cartelle generiche.
3. Preparare commit separati per API/SQL, interfacce e strumenti locali,
   includendo i rispettivi test e le note sui limiti.
4. Verificare l'esatto contenuto preparato e le dipendenze importate prima di
   registrare i commit. Nessun push, reset, pulizia o merge è implicito.

I file vengono preparati da elenchi espliciti, verificando poi che il contenuto
nell'indice coincida con quello revisionato. Nessuna aggiunta in blocco.

## Avanzamento checkout

Audit attivo ricevuto. Policy listing e funzioni indirizzi/quote corrette con
riscontri di installazione dell'utente. Funzione create_order completa provata
con 23 controlli PostgreSQL, inclusa concorrenza e recupero dopo commit con ID
scartato; nuova guardia contro listing riaperti con ordini in corso preparata
in fix-create-order-guard.sql, installazione ancora da confermare. Fixture e
default sono sintetici, non baseline dell'intero schema remoto.

Il client blocca richieste duplicate nello stesso componente e gestisce esiti
incerti/ID noto; non dispone di recupero automatico o idempotency key persistente.
Durante quei controlli non erano ancora stati eseguiti staging o commit;
il consolidamento successivo è descritto qui sotto.

L'utente ha successivamente fornito il riscontro di installazione della guardia
create_order: search_path atteso, anon escluso, authenticated/service abilitati.
Nessuno script di questo blocco resta in attesa del relativo riscontro.

## Consolidamento selettivo

Organizzazione in quattro commit locali, senza push:

- `7e9b532`: sola dipendenza server-only in package.json e lockfile (8 righe).
  Le aggiunte preesistenti buffer e Supabase CLI rimangono fuori dai commit.
- `262f870`: 63 file backend/SQL/test e documentazione escrow. Fixture sintetiche
  incluse; nessun wallet, .env, log o runtime scaricato.
- `064d7bf`: 11 file interfaccia/ricevute e relativi test.
- Commit separato strumenti locali/test di integrazione/riepiloghi: 15 file,
  identificabile dal titolo `test: preserve isolated local integration setup`.

Verificati import locali dei file selezionati, corrispondenza indice/file,
consistenza manifesto/lock e assenza di pattern di chiavi private nelle sole
sorgenti selezionate. Il controllo non certifica l'intera storia Git né i file
preesistenti esclusi. Eliminata una riga vuota finale nella fixture SQL senza
modificarne il contenuto applicativo; nessun test di firma ripetuto.

Il working tree resta volutamente sporco per le modifiche escluse. Nessun reset,
pulizia, merge, push o deployment. Nessun build di produzione che possa caricare
.env reali effettuato per il consolidamento. Le prove tecniche dei singoli blocchi
sono registrate nei riepiloghi; il solo commit non certifica il rilascio.

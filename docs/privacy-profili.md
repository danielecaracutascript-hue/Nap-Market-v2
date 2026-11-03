# Separazione dei profili pubblici

L'audit remoto del 30 ottobre 2026 conferma SELECT pubblico su tutte le sette
colonne di profiles e policy `profiles readable USING(true)`. Ciò comprende
wallet_xpub e l'intero JSON business_info. INSERT/UPDATE restano limitati al
proprietario dalle policy: i grant ampi non dimostrano modifiche arbitrarie.

La patch `supabase/security/separate-public-profiles.sql` mantiene i dati e le
policy di scrittura e sostituisce la lettura globale con lettura del proprietario
autenticato. Il servizio conserva l'accesso per le operazioni autorizzate. Non
modifica o cancella chiavi pubbliche, profili, annunci, indirizzi o ordini.

La vista `public_profiles`, esplicitamente posseduta da postgres, usa i privilegi
del proprietario per pubblicare soltanto id, handle, country, seller_type e due
campi dei venditori professionali: business_name e vat_id, già mostrati negli
annunci. business_info dei privati è NULL; eventuali altri campi JSON restano
esclusi. wallet_xpub, created_at e nuove colonne future non entrano nella vista.
Ai tre ruoli applicativi è concesso soltanto SELECT sulla vista. L'accesso al
profilo completo è protetto da RLS, anche se il grant SELECT di tabella continua
a comparire true nel report. La vista non richiede RLS perché contiene soltanto
la proiezione pubblica intenzionale.

**Installazione coordinata con il codice aggiornato:** annuncio e pagina arbitro
leggono la nuova vista. La preparazione escrow verifica prima compratore e ordine
con il client dell'utente, quindi il client server amministrativo legge soltanto
id/wallet_xpub dei due partecipanti di quell'ordine. Nessuna chiave viene resa
pubblica dalla route. Il wallet continua a leggere/aggiornare il proprio profilo;
la pagina profilo richiede soltanto i campi che modifica. Gli escrow già salvati
continuano a usare il descriptor originario. Se esiste una copia del sito online,
va aggiornata insieme alla patch; non lasciare vecchi chiamanti che dipendono
dalla lettura globale dei profili.

Lo script rifiuta proprietario/RLS inattesi, altre policy SELECT/ALL e un oggetto
public_profiles già presente senza il marcatore di questa patch. Non tenta di
correggere automaticamente tali differenze. La riesecuzione prevista conserva i
dati; la transazione evita un'applicazione parziale. Non è una retrocessione di
dati già esposti: vecchie copie/cache pubbliche non vengono eliminate da RLS.

Validazione locale: 18 controlli PostgreSQL con ruoli reali (isolamento, vista,
JSON ridotto, ACL, dati invariati all'installazione, upsert profilo e aggiornamento
della propria chiave pubblica); 6 controlli con Auth/PostgREST reali; 15 controlli
della preparazione/funding con Core in sola lettura per descriptor/indirizzi e
operazioni di import/pagamento simulate; 30 controlli Next HTTP, inclusa la pagina
annuncio aggiornata. Passati anche 36 casi preparazione escrow, 12 componente
arbitro, TypeScript e lint. Nessuna firma, finalizzazione o trasmissione Bitcoin.
Nessun profilo reale letto. La prova visiva resta da completare.

Per la riproduzione locale, le opzioni `--profile-privacy` dei runner Supabase e
Next attivano i controlli aggiuntivi. Il runner Supabase ricrea policy di fixture
e poi applica la separazione al solo progetto sintetico; senza questa opzione
ripristina la sua fixture permissiva. Non usarlo contro il database remoto.

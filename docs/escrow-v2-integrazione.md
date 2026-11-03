# Escrow V2: integrazione graduale e compatibilita' Legacy V1

## Stato confermato

Gli ordini esistenti conservano un descriptor escrow immutabile. Il percorso
Legacy V1 costruisce un policy con chiave piattaforma e finestre temporali,
salva descriptor, indirizzo e indice sull'ordine, poi prepara i PSBT di
rilascio/rimborso con la relativa commissione piattaforma.

Il prototipo Escrow V2 e' invece un P2WSH `sortedmulti(2, ...)` tra
compratore, venditore e arbitro. La firma locale V2 controlla un solo input e
una sola uscita, aggiunge una firma parziale ECDSA e rifiuta esplicitamente un
PSBT gia' finalizzato. Non trasmette, non finalizza e non e' collegato agli
ordini.

## Regola di compatibilita'

Un ordine gia' creato, e soprattutto un ordine FUNDED, deve continuare a usare
solo il descriptor e il percorso di regolamento gia' memorizzati. Non deve
esistere alcuna conversione automatica V1 -> V2, ne' una rigenerazione di
indirizzi o chiavi per dati storici.

Prima di rendere V2 disponibile ai nuovi ordini, gli ordini devono avere una
versione protocollo esplicita, con default `legacy_v1`. L'eventuale migrazione
deve aggiungere soltanto il campo e assegnare `legacy_v1` ai record esistenti;
non deve toccare descriptor, indirizzi, funding o PSBT gia' presenti.

## Blocchi funzionali da risolvere

1. Arbitro immutabile al funding. Oggi `open_dispute` sceglie un arbitro quando
   la disputa viene aperta. In un 2-su-3 V2 l'arbitro deve essere gia' scelto
   prima della creazione dell'indirizzo e la sua chiave pubblica deve essere
   salvata nella snapshot dell'ordine. Non e' possibile sostituirla dopo il
   funding senza una nuova transazione firmata.

2. Commissioni. Il prototipo V2 autorizza un solo output. I regolamenti Legacy
   usano invece output separati per beneficiario e piattaforma. Un flusso V2
   commerciale deve definire importi, destinatari e limite di fee per ogni
   esito (rilascio, rimborso, reso, disputa), e ogni firmatario deve verificarli
   prima di firmare. Non e' sicuro riusare i preparatori PSBT Legacy.

3. Snapshot e osservazione funding. Per ogni ordine V2 occorrono protocollo,
   tre chiavi pubbliche con origine, indice, witness script, descriptor con
   checksum e indirizzo P2WSH. Il watcher puo' osservare solo l'indirizzo
   memorizzato; non deve mai ricostruire il descriptor da profili modificabili.

4. Separazione dei percorsi. Le API di preparazione, verifica, firma parziale,
   invio e riconciliazione dovranno fare dispatch per versione protocollo. Le
   API Legacy non devono accettare un ordine V2 e viceversa. Fino ad allora V2
   rimane in sviluppo e non e' selezionabile dal checkout.

## Sequenza proposta

1. Modello scelto: la piattaforma e' la terza chiave V2. La chiave escrow deve
   restare separata dall'app e da chi decide le dispute; una firma richiede
   sempre anche compratore o venditore. L'assegnazione di un arbitro esterno
   resta una futura variante, solo se scelto e congelato prima del funding.
2. Definire la ripartizione on-chain di commissioni e fee per tutti gli esiti.
3. Preparare una migrazione solo-schema con `escrow_protocol = legacy_v1` e
   snapshot V2 opzionale, verificata prima su Supabase locale isolato.
4. Aggiungere un percorso V2 solo per nuovi ordini sintetici, protetto da flag
   server e con registrazione immutabile della snapshot.
5. Implementare e verificare PSBT V2 di rilascio e rimborso, ciascuno con due
   firme parziali, senza finalizzazione o broadcast automatico.
6. Solo dopo test indipendenti di tutti gli esiti, abilitare V2 a un gruppo
   limitato di nuovi ordini. Legacy V1 continua a gestire tutti gli altri.

## Stato attuale

Completati: modello con terza chiave escrow della piattaforma, descriptor P2WSH
candidato, derivazione script, preview server in sola lettura, controllo UTXO
in sola lettura, prima firma parziale locale verificata e verifica offline del
PSBT di settlement (input, P2WSH, uscite esatte, fee e PSBT non finalizzato).
Un preparatore server-side crea ora soltanto PSBT V2 non firmati da un UTXO
fornito e ne inserisce le derivazioni pubbliche. Non completati: schema
snapshot/versione V2, API di settlement V2, seconda firma, finalizzazione
controllata, revisione indipendente e rollout. Non esistono modifiche a fondi,
chiavi o ordini reali in questo documento.

Il 2 novembre 2026 e' stata installata `escrow_protocol` su Supabase con
default `legacy_v1` e vincolo `legacy_v1 | escrow_v2`. Il risultato catalogo
conferma il campo NOT NULL e il default; il vincolo e' intenzionalmente NOT
VALID per evitare una scansione/rischio operativo sugli ordini storici, che
leggono comunque tutti `legacy_v1` dal default costante. Le API Legacy
rifiutano esplicitamente ogni protocollo diverso da `legacy_v1` finche' i
percorsi V2 di funding e settlement non saranno completi.

Preparata `add-escrow-v2-snapshot.sql`: aggiunge solo le colonne opzionali di
snapshot V2 e la funzione server-only che le salva sotto lock per un ordine
gia' marcato `escrow_v2`. Gli ordini Legacy sono vincolati ad avere tali colonne
NULL. La migrazione e' stata verificata insieme a `escrow_protocol` sul
database locale isolato, con rollback finale; non e' ancora stata eseguita su
Supabase remoto.

# Politica rimborsi legacy

Decisione dell'utente del 30 ottobre 2026: se il caso nasce da un reso,
la commissione del compratore resta trattenuta anche quando l'arbitro
decide successivamente a favore del compratore.

La precedenza di return_requested rispetto a dispute_decided in
refundKindFromEvents è quindi intenzionale. Non dipende dall'ordine in cui
gli eventi vengono restituiti. Questa conferma non cambia i calcoli già
installati, non modifica ordini storici e non rigenera bozze esistenti.

Comportamenti attuali mantenuti:

| Caso | Commissione compratore |
| --- | --- |
| Reso | Trattenuta |
| Reso con disputa successiva decisa per il compratore | Trattenuta |
| Disputa decisa per il compratore senza evento di reso | Restituita |
| Rimborso per mancata spedizione | Restituita |

La commissione Bitcoin di rete viene sottratta dal payout in tutti i casi.
Questa regola riguarda buyer_commission_sats, non l'eventuale tariffa
di arbitraggio riportata negli eventi della disputa.

Esempio sintetico: prezzo 100.000 sat, commissione compratore 4.000 sat,
escrow totale 104.000 sat, rete 700 sat. In caso di reso (anche con disputa
vinta dal compratore), compratore 99.300 sat e piattaforma 4.000 sat;
nel ramo disputa senza reso, compratore 103.300 sat e piattaforma zero.

Verifiche: cinque casi di policy con helper reale e route refund prepare/submit
(arresto alla verifica pubblica, nessuna firma), inclusi entrambi gli ordini
degli eventi reso/disputa. La route reconcile usa ora l'helper reale nel test:
22 scenari complessivi passati, inclusa coerenza per entrambi gli ordini
degli eventi. Nessun dato reale o operazione Bitcoin usato nei test.

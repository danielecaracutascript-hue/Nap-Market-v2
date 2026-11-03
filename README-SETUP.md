# Setup Bitcoin Core per il Marketplace

## 1. Aggiorna .env.local

Aggiungi queste variabili al file `marketplace/.env.local`:

```env
BITCOIN_RPC_URL=http://127.0.0.1:18443
BITCOIN_RPC_COOKIE_PATH=C:\btc-poc\regtest\.cookie
PLATFORM_XPUB=[da318210/84'/1'/0']tpubDCqFfjsRMVjzxiDQ7qKNBe7wwj8cXUHA9p1EdfiuhwtapfVhjwHCsc6dU9Eg2ao5UHu56eWbzrch1wu2yASzDPKyJ6zE5cG5KaHqePZGS4o
ESCROW_CONCORDATA_BLOCKS=5
ESCROW_BUYER_TIMELOCK_BLOCKS=10
```

## 2. Wallet Bitcoin Core creati

I seguenti wallet sono già stati creati sul nodo regtest:
- `miner` - wallet principale con 6598+ BTC
- `buyer` - wallet acquirente
- `seller` - wallet venditore
- `platform` - wallet piattaforma
- `escrow1` - wallet per importare descriptor escrow
- `shipping` - wallet per indirizzi shipping

## 3. Chiavi di test per il frontend

Usa queste mnemonic per creare wallet nel marketplace:

**Buyer:**
```
valid innocent cargo crucial conduct animal wink timber exclude accident uncover fee
```

**Seller:**
```
clog claim napkin dignity follow seven dutch cigar later stereo scene odor
```

## 4. Verifica connessione

```bash
cd marketplace
node test-bitcoin.js
```

Dovresti vedere:
```
✓ Blocco corrente: 232
✓ Wallet caricati: miner, buyer, seller, platform, escrow1, shipping
✓ Balance miner: 6598.95902534 BTC
✓ Connessione riuscita!
```

## 5. Riavvia il dev server

Dopo aver aggiornato `.env.local`, riavvia il server Next.js:

```bash
cd marketplace
npm run dev
```

## 6. Test del flusso ordine

1. Vai su http://localhost:3000
2. Crea un account come BUYER (usa la mnemonic buyer)
3. Crea un account come SELLER (usa la mnemonic seller)
4. Crea un listing come seller
5. Acquista come buyer
6. Quando vedi l'ordine, clicca "Get payment details"
7. Dovrebbe funzionare senza errore

## Note

- Il nodo Bitcoin Core deve essere in esecuzione su regtest (porta 18443)
- Se il nodo è fermo, avvialo con: `bitcoind -regtest -datadir=C:\btc-poc\regtest`
- I wallet sono persistenti sul nodo, non ricrearli

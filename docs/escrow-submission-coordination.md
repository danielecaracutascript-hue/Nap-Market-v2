# Persistent escrow submission coordination

Scope: the primary app in C:\progetti\marketplace. Legacy scripts, descriptors, historical orders and PSBTs are not migrated. Other checkouts are not patched by this change.

## Deployment

Run supabase/security/add-escrow-submission-claims.sql once in the Supabase SQL Editor as postgres, and retain its final metadata result. The script creates a new table and a restricted function; it does not call the function, inspect order data or send Bitcoin. It deliberately fails if a table with that name already exists so an unknown schema is not silently accepted. If the transaction fails, roll it back before retrying.

The updated prepare and submit routes refuse new work if the coordination table/function is missing or unreadable. Existing order TXIDs and historical broadcast PSBTs are still recognized first. All running instances that can send must use this updated code before enabling settlement; an old checkout does not participate in these claims.

## Submission rules

- Compute the candidate TXID locally from the raw transaction returned by Core.
- Claim the order in a database transaction before sendrawtransaction. The function locks the order row, verifies its status and funding outpoint, and checks the referenced draft belongs to that order and purpose.
- The order primary key prevents competing purposes/drafts from acquiring a second attempt. A separate unique funding outpoint also prevents reuse across different orders.
- Only the request receiving an unambiguous acquired=true result may send. A lost response from the claim RPC causes no send by that request; a committed claim remains recoverable on a later read.
- Persist pending before the network call. After Core acknowledges the exact candidate TXID, record broadcast; then a single server-only SQL function records the order, PSBT and reconciled state atomically.
- Errors or timeouts after a claim return an uncertain receipt, with broadcast=false and submissionPending=true. This is not evidence that a transaction was sent. The browser retains the public receipt and disables retries in that session; the database claim blocks them across devices and processes using the updated routes.
- Claims are never automatically expired, deleted or reused, even after an explicit node rejection or a crash before sending. This deliberately trades availability for protection against a second submission.

## Recovery limits

A pending claim remains blocked. The order-page status button calls the authenticated settlement/reconcile route. It may reconcile records only after a read-only verifier finds the reserved transaction in an active block, checks its exact prepared transaction, original funding script/address/value, destination, commission and fee, and rechecks the active block hash. Unknown, unconfirmed, inactive, unavailable or mismatching evidence never unlocks the claim. A process crash before sending can therefore still require administrator review even when nothing was transmitted. No automatic rebroadcast, replacement transaction or claim deletion is implemented.

The table stores only public TXIDs/outpoints, order/draft identifiers, a coordination UUID and state/timestamps. It stores no raw transaction, PSBT, mnemonic, password or signing key. Public clients cannot read it or invoke the claim function; service_role can read and update only state/acknowledged_at, while the restricted function inserts validated claims.

No historical uncertainty is automatically reconstructed or backfilled. The deployment does not establish that a transaction sent by old code was never broadcast.

## Verification

Offline TypeScript/JavaScript suites use only synthetic public data and inert signing/finalization/broadcast stubs. They test duplicate attempts, coordination errors, wrong acknowledgments, uncertain outcomes, database persistence errors and browser receipts. The initial buyer V2 ECDSA test has not been repeated.

On 29 October 2026, the installation and reconciliation SQL passed 24 integration checks on a new, isolated PostgreSQL 17.10 cluster. Two separate database sessions were observed waiting on real locks. Exactly one acquired a contested order; a unique outpoint prevented claims from two different orders. Tests also covered rollback on disconnect before commit, retention after commit and client disconnection, a full server restart, invalid metadata, historical broadcast records and restricted permissions. The SQL ran under a non-superuser owner without BYPASSRLS; anonymous and authenticated callers were denied. Orders and legacy PSBTs remained unchanged by claim creation. Additional reconciliation tests exercised two concurrent calls, once-only legacy events, transaction rollback after injected legacy/PSBT errors, silent legacy no-ops and order/draft snapshot changes. Legacy release/refund bodies are test doubles in this isolated fixture; the production reconciliation function delegates to the installed legacy functions rather than replacing them.

The native database runner creates its own minimal fixture schema, uses only localhost, reads no application credentials and stops the server in cleanup. It does not connect to Supabase or Bitcoin Core. This verifies the coordination SQL, not the full Supabase schema, PostgREST deployment or blockchain reconciliation. Those end-to-end checks remain outstanding before production use.

Commands from marketplace:

    node tests/escrow-settlement.mjs
    node tests/escrow-receipt.mjs
    node tests/escrow-submission.mjs
    node tests/escrow-reconciliation-proof.mjs
    node tests/escrow-reconciliation-route.mjs
    node tests/legacy-escrow-policy.mjs
    node node_modules/typescript/bin/tsc --noEmit --incremental false

Native integration runner (Windows x64, separate temporary runtime):

    node tests/escrow-postgres-integration.mjs

The runner expects `pg@8.16.3` and `@embedded-postgres/windows-x64@17.10.0-beta.17` under `../work/pg-validation/node_modules`; it also accepts that runtime directory as its first argument. They are test tools, not application dependencies. Localhost process/connection permissions may be required. Synthetic clusters and reports stay under the ignored work directory; no automatic recursive deletion is performed.

Reference for order-row locking: https://www.postgresql.org/docs/17/explicit-locking.html
Reference for row policies: https://www.postgresql.org/docs/17/ddl-rowsecurity.html

## Reconciliation deployment and boundaries

Install supabase/security/add-escrow-reconciliation.sql once as postgres after the claims schema. Installation creates a server-only function and grants; it does not call the function or touch order rows. The function locks the order and claim, rechecks the descriptor/address/index/amounts/PSBT snapshot, invokes mark_order_released or mark_order_refunded only when its target TXID is missing, verifies that the expected TXID was recorded, and updates the PSBT/claim in the same transaction. Confirmed reconciliation preserves PSBT bytes and all descriptors. The normal acknowledged-submit path now uses this same function with p_confirmed=false and its signed PSBT, preserving the previous signature-persistence behavior without downgrading an already confirmed row. Signature metadata conversion is tested with both SQL arrays and JSONB columns. Repeated calls with the same claim are idempotent, including races between the normal acknowledgment path and confirmed reconciliation; a stale PSBT snapshot is refused and must be verified again. Conflicts and SQL failures roll back all changes.

Only order participants can call the API. The API uses getblockchaininfo, gettransaction, getrawtransaction, getblockheader and getblockhash, each with a timeout; it has no signing, finalization or transmission operation. It checks the actual parent transaction value, not the PSBT witnessUtxo amount. The final block-specific getrawtransaction lookup must report in_active_chain=true. Missing/pruned transaction data or an unsynchronized node produces a blocked review result, never an absence-based retry. A confirmed proof followed by SQL failure returns the known TXID with reconciliation still required.

Current verification supports configured regtest, signet and legacy testnet (Core chain name test), and requires at least one active-chain confirmation. Mainnet and testnet4 are refused. The original escrow address is checked under that network; signet/testnet share address encoding, and legacy claims do not persist a separate genesis/network identifier, so the configured node must remain on the original funding network. There is no automatic network migration, monitoring of later reorganizations or automatic reversal of reconciled business data. Claims remain reserved in all cases.

The proof suite uses synthetic public BIP32 nodes and unsigned transaction/PSBT fixtures; Core responses are mocked. No wallet secrets or ECDSA signatures are generated, and the passed buyer V2 test is not repeated. PostgreSQL tests use a minimal fixture and test doubles for existing legacy business functions. Real Core/PostgREST/full-schema integration remains untested.

Bitcoin Core reference: https://bitcoincore.org/en/doc/24.0.0/rpc/rawtransactions/getrawtransaction/

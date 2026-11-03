
import * as bitcoin from "bitcoinjs-lib";
import * as bip39 from "bip39";
import * as descriptors from "@bitcoinerlab/descriptors";

import type { EscrowParticipants } from "./escrow-v2";
import { deriveEscrowV2WitnessScript } from "./escrow-v2-script";

export type SignEscrowV2Args = {
  mnemonic: string;
  psbtBase64: string;

  expectedPubkey: Uint8Array;

  participants: EscrowParticipants;
  escrowIndex: number;

  expectedTxid: string;
  expectedVout: number;
  expectedWitnessScript: Uint8Array;
  expectedInputSats: bigint;

  expectedDestination: string;
  expectedOutputSats: bigint;
  maxFeeSats: bigint;

  network: "regtest" | "signet";
};

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function requireCondition(
  condition: boolean,
  message: string
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function getNetwork(
  chain: "regtest" | "signet"
): bitcoin.Network {
  if (chain === "regtest") {
    return bitcoin.networks.regtest;
  }

  if (chain === "signet") {
    return bitcoin.networks.testnet;
  }

  throw new Error("Unsupported escrow network");
}

export async function signEscrowV2(
  args: SignEscrowV2Args
): Promise<string> {
  const {
    mnemonic,
    psbtBase64,
    expectedPubkey,
    participants,
    escrowIndex,
    expectedTxid,
    expectedVout,
    expectedWitnessScript,
    expectedInputSats,
    expectedDestination,
    expectedOutputSats,
    maxFeeSats,
    network,
  } = args;

  const btcNetwork = getNetwork(network);

  // 1. Parse PSBT
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, {
    network: btcNetwork,
  });

  requireCondition(
    psbt.inputCount === 1,
    "Escrow V2 requires exactly one input"
  );

  requireCondition(
    psbt.txOutputs.length === 1,
    "Escrow V2 requires exactly one output"
  );

  // 2. Verify authorized outpoint
  const txInput = psbt.txInputs[0];

  const actualTxid = Buffer.from(txInput.hash)
    .reverse()
    .toString("hex");

  requireCondition(
    actualTxid.toLowerCase() ===
      expectedTxid.toLowerCase(),
    "Unexpected escrow TXID"
  );

  requireCondition(
    txInput.index === expectedVout,
    "Unexpected escrow VOUT"
  );

  const input = psbt.data.inputs[0];

  requireCondition(
    !!input.witnessUtxo,
    "Missing witness UTXO"
  );

  requireCondition(
    !!input.witnessScript,
    "Missing witness script"
  );

  requireCondition(
    !input.finalScriptWitness && !input.finalScriptSig,
    "Escrow V2 PSBT is already finalized"
  );

  // 3. Reconstruct authorized multisig script
  const reconstructedScript =
    deriveEscrowV2WitnessScript(
      participants,
      escrowIndex
    );

  requireCondition(
    hex(reconstructedScript) ===
      hex(expectedWitnessScript),
    "Authorized script does not match participant keys"
  );

  requireCondition(
    hex(input.witnessScript!) ===
      hex(reconstructedScript),
    "PSBT script does not match authorized escrow"
  );

  // 4. Verify P2WSH locking script
  const witnessHash = bitcoin.crypto.sha256(
    reconstructedScript
  );

  const expectedLockingScript = bitcoin.script.compile([
    bitcoin.opcodes.OP_0,
    witnessHash,
  ]);

  requireCondition(
    hex(input.witnessUtxo!.script) ===
      hex(expectedLockingScript),
    "Unexpected P2WSH locking script"
  );

  // 5. Verify amounts
  requireCondition(
    input.witnessUtxo!.value === expectedInputSats,
    "Unexpected escrow input amount"
  );

  const output = psbt.txOutputs[0];

  requireCondition(
    output.value === expectedOutputSats,
    "Unexpected payment amount"
  );

  // 6. Verify destination
  const destinationScript =
    bitcoin.address.toOutputScript(
      expectedDestination,
      btcNetwork
    );

  requireCondition(
    hex(output.script) === hex(destinationScript),
    "Unauthorized payment destination"
  );

  // 7. Verify fee
  const fee = expectedInputSats - output.value;

  requireCondition(
    fee >= BigInt(0),
    "Negative transaction fee"
  );

  requireCondition(
    fee <= maxFeeSats,
    "Transaction fee exceeds authorized limit"
  );

  // 8. Require SIGHASH_ALL
  requireCondition(
    input.sighashType === undefined ||
      input.sighashType ===
        bitcoin.Transaction.SIGHASH_ALL,
    "Unsupported sighash type"
  );

  // 9. Validate mnemonic
  const normalizedMnemonic = mnemonic
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  requireCondition(
    bip39.validateMnemonic(normalizedMnemonic),
    "Invalid wallet mnemonic"
  );

  // 10. Derive participant key
  const seed = await bip39.mnemonicToSeed(
    normalizedMnemonic
  );

  const master = descriptors.BIP32.fromSeed(
    seed,
    bitcoin.networks.testnet
  );

  const matchingDerivation =
    input.bip32Derivation?.find(
      (entry) =>
        hex(entry.pubkey) === hex(expectedPubkey)
    );

  requireCondition(
    !!matchingDerivation,
    "Participant key is not authorized in PSBT"
  );

  // Never trust a derivation path supplied by the PSBT.
  requireCondition(
    Number.isSafeInteger(escrowIndex) &&
      escrowIndex >= 0 &&
      escrowIndex < 0x80000000,
    "Invalid escrow derivation index"
  );

  const authorizedPath =
    `m/84'/1'/0'/0/${escrowIndex}`;

  requireCondition(
    matchingDerivation!.path === authorizedPath,
    "Unauthorized BIP32 derivation path"
  );

  const authorizedXpubs = [
    participants.buyerXpub,
    participants.sellerXpub,
    participants.platformEscrowXpub,
  ];

  const authorizedPubkeys = authorizedXpubs.map(
    (xpub) =>
      descriptors.BIP32.fromBase58(
        xpub.replace(
          /^\[[0-9a-fA-F]{8}\/84h\/1h\/0h\]/,
          ""
        ),
        bitcoin.networks.testnet
      )
        .derive(0)
        .derive(escrowIndex)
        .publicKey
  );

  requireCondition(
    authorizedPubkeys.some(
      (pubkey) => hex(pubkey) === hex(expectedPubkey)
    ),
    "Participant public key is not authorized"
  );

  const derived = master.derivePath(
    authorizedPath
  );

  requireCondition(
    hex(derived.publicKey) === hex(expectedPubkey),
    "Wallet key does not match expected participant"
  );

  requireCondition(
    hex(matchingDerivation!.masterFingerprint) ===
      hex(master.fingerprint),
    "Wallet master fingerprint mismatch"
  );

  requireCondition(
    !!derived.privateKey,
    "Missing participant private key"
  );

  // 11. Preserve existing signatures
  const previousSignatures = (
    input.partialSig ?? []
  ).map((signature) => ({
    pubkey: hex(signature.pubkey),
    signature: hex(signature.signature),
  }));

  // 12. Sign authorized input
  const keyPair = descriptors.ECPair.fromPrivateKey(
    derived.privateKey!,
    { network: bitcoin.networks.testnet }
  );

  psbt.signInput(
    0,
    {
      publicKey: derived.publicKey,
      sign: (hash: Uint8Array) => keyPair.sign(hash),
    },
    [bitcoin.Transaction.SIGHASH_ALL]
  );

  // 13. Verify signature preservation
  const finalSignatures =
    psbt.data.inputs[0].partialSig ?? [];

  for (const previous of previousSignatures) {
    requireCondition(
      finalSignatures.some(
        (signature) =>
          hex(signature.pubkey) === previous.pubkey &&
          hex(signature.signature) ===
            previous.signature
      ),
      "Existing participant signature was modified"
    );
  }

  requireCondition(
    finalSignatures.some(
      (signature) =>
        hex(signature.pubkey) === hex(expectedPubkey)
    ),
    "Participant signature was not added"
  );

  // 14. Cryptographically validate the new signature
  const validSignature = psbt.validateSignaturesOfInput(
    0,
    (pubkey, hash, signature) => {
      const verifier = descriptors.ECPair.fromPublicKey(
        pubkey,
        { network: bitcoin.networks.testnet }
      );

      return verifier.verify(hash, signature);
    },
    Buffer.from(expectedPubkey)
  );

  requireCondition(
    validSignature,
    "Escrow V2 ECDSA signature verification failed"
  );

  requireCondition(
    !psbt.data.inputs[0].finalScriptWitness &&
      !psbt.data.inputs[0].finalScriptSig,
    "Escrow V2 PSBT must remain unfinalized"
  );

  return psbt.toBase64();
}

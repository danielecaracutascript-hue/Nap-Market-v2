export type LegacyEscrowKeys = Readonly<{
  buyerXpub: string;
  sellerXpub: string;
  platformXpub: string;
}>;

/** Recover roles only from the complete legacy policy created by escrow/route.ts.
 * Unknown policies must be reviewed, never reconstructed from current profiles.
 * This parses public metadata; key validity is checked by BIP32 when deriving.
 */
export function legacyEscrowKeys(descriptor: string | null | undefined): LegacyEscrowKeys {
  if (!descriptor) throw new Error("Missing original escrow descriptor");
  const body = descriptor
    .replace(/#[a-z0-9]{8}$/i, "")
    .replace(/\[[^\]]*\]/g, (origin) => origin.replace(/(\d)h/g, "$1'"));
  const keys = body.match(
    /(?:\[[0-9a-fA-F]{8}(?:\/[0-9]+'?)*\])?(?:tpub|xpub)[1-9A-HJ-NP-Za-km-z]{100,120}\/[012]\/\*/g,
  );
  const delays = [...body.matchAll(/older\(([0-9]+)\)/g)].map((match) => match[1]);
  if (keys?.length !== 6 || delays.length !== 2) {
    throw new Error("Unsupported legacy escrow descriptor; manual review required");
  }
  const [platformXpub, buyerXpub, sellerXpub] = keys.slice(0, 3).map((key) => key.slice(0, -4));
  const k = (key: string, branch: number) => `${key}/${branch}/*`;
  const expected =
    `wsh(or_i(and_v(v:pk(${k(platformXpub, 0)}),or_d(pk(${k(buyerXpub, 0)}),pk(${k(sellerXpub, 0)}))),` +
    `or_i(and_v(v:multi(2,${k(buyerXpub, 2)},${k(sellerXpub, 2)}),older(${delays[0]})),` +
    `and_v(v:pk(${k(buyerXpub, 1)}),older(${delays[1]})))))`;
  if (body !== expected) {
    throw new Error("Unsupported legacy escrow descriptor; manual review required");
  }
  return { buyerXpub, sellerXpub, platformXpub };
}

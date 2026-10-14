const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n;

/**
 * Whether r and s, 64 hex characters each, are in range with s in the lower half of the curve order. Every ECDSA
 * signature has a second valid spelling with s replaced by n - s and v flipped, which recovers the same signer, so
 * refusing the high s one leaves one valid signature per signed text. bee-js and the Swarm ID fork both sign low s.
 */
export function isCanonicalSignature(rHex: string, sHex: string): boolean {
  const r = BigInt(`0x${rHex}`);
  const s = BigInt(`0x${sHex}`);
  return r > 0n && r < SECP256K1_ORDER && s > 0n && s <= SECP256K1_HALF_ORDER;
}

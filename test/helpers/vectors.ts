// docs/research/vectors.json, computed by agenttool's own functions at
// e9ea51c5. Every key in it is a public test value; none is ever registered.
import raw from "../../docs/research/vectors.json";

export const vectors = raw;

/** kingdom-seat's test op key (seed = sha256("kingdom-seat test op key v1")), not derived from the mnemonic. */
export const TEST_OP_SEED_HEX: string = raw.op_key.seed_hex;
export const TEST_OP_PUBLIC_B64: string = raw.op_key.public_key_b64;

/** The root seed derived from the `abandon … about` test mnemonic. */
export const TEST_ROOT_SEED_HEX: string = raw.derivation.signing_seed_hex;
export const TEST_ROOT_PUBLIC_B64: string = raw.derivation.signing_pub_b64;
export const TEST_MNEMONIC: string = raw.derivation.mnemonic;

export const TEST_IDS = raw.ids;

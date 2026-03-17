// @usertools/verify — Standalone Audit Verification (zero dependencies)

export { canonicalize } from "./canonical.js";
export { GENESIS_HASH } from "./constants.js";
export {
	verifyChain,
	buildMerkleTree,
	hashLeaf,
	hashInternal,
	generateInclusionProof,
	verifyInclusionProof,
	generateConsistencyProof,
	verifyConsistencyProof,
	type ChainVerificationResult,
	type MerkleSibling,
	type MerkleInclusionProof,
	type MerkleConsistencyProof,
} from "./verify.js";

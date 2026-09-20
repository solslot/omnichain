# Base mainnet authority deployment preparation

The Authority V3 deployment runner supports `baseMainnet` (8453) and
`baseSepolia` (84532) independently of its Chia `testnet11` authority roster.
The selected Hardhat network determines the RPC variable used by both ethers
and the Safe SDK. Mainnet uses `BASE_MAINNET_RPC_URL`; Sepolia uses
`BASE_SEPOLIA_RPC_URL`. There is no fallback between them.

Before obtaining a deployment signer, the runner checks the network name,
configured chain ID and live RPC chain. Governance evidence validation checks
the same name/chain pairing against the live provider. Existing owner-plus-one
authority, three distinct identities, recovery controls and delay requirements
remain enforced.

This change prepares the governance deployment tooling. It does not migrate
the API, browser signature domains, Chia payment puzzles or Samuel bridge
coordinates. Those consumers must be prepared and verified before activating
a Base-mainnet release. Funding a deployment wallet is not a deployment receipt.

Deployment inputs still include the actual frozen three-admin roster and its
recovery drills, source manifest, launcher IDs and deployment signer. They must
come from the enrollment ceremony; sample identities are not valid substitutes.

Validation:

```sh
npm ci --ignore-scripts
npm test
npm run security:audit-production
```

The network tests exercise Base mainnet and Sepolia separately, reject crossed
RPC/evidence networks, and preserve the owner-plus-one recovery topology.

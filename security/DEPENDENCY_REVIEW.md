# Dependency Review

## Runtime classification

The repository primarily deploys Solidity bytecode. The exact-SHA launch rehearsal coordinator also uses `ethers` at runtime. `ethers` is therefore the only direct production Node.js dependency. Hardhat, Chainlink Solidity sources, OpenZeppelin Solidity sources, Safe tooling, compiler tooling, coverage, and explorer plugins are development dependencies used to build, test, and deploy.

## RC25 audit result

The August 2, 2026 audit found a vulnerable production WebSocket dependency through `ethers@6.14.0`. RC25 updates `ethers` to `6.17.0`, which resolves production `ws` to `8.21.0`. `npm audit --omit=dev` then reports zero vulnerabilities. CI and the exact-SHA staging workflow enforce that result at `audit-level=low`.

GitHub reports 29 open Dependabot alerts on the default branch. Every alert is classified as development scope. They are rooted in the pinned Hardhat 2, Chainlink CCIP 1.x, Safe tooling, and their historical Solidity compatibility packages. They include old WebSocket, archive, temporary-file, serialization, HTTP, utility, and OpenZeppelin packages. The affected OpenZeppelin contracts named by the advisories are not imported by Solslot's deployed contracts, but the packages remain part of the trusted build input.

Removing the remaining development alerts requires a separately reviewed Hardhat 3/toolbox 7 migration and a Chainlink dependency-graph decision. `npm audit fix --force` is prohibited on a frozen release because it changes compiler, test, deployment, and source-package behavior without compatibility evidence.

## Controls

- Install from the committed lockfile with `npm ci` in an isolated build environment.
- Fail CI and exact-SHA release builds if any production advisory is present.
- Never expose Hardhat tooling as a network service.
- Do not use untrusted RPC, source, configuration, or test inputs on the signing/deployment host.
- Build and compare bytecode in two isolated environments before deployment.
- Use a hardware-backed deployer and transfer ownership immediately to the reviewed timelock.
- Re-evaluate the Hardhat 3/toolbox 7 migration in a dedicated compatibility branch; do not use `npm audit fix --force` on the release branch.
- Keep the development toolchain off internet-facing production services and do not expose deployment credentials to pull-request jobs.
- Re-run the dependency audit and update this review immediately before external audit freeze.

## Mainnet follow-up

Before mainnet freeze, migrate or replace the remaining vulnerable development dependency paths in an isolated branch, reproduce all bytecode and deployment evidence, and rerun the full contract and ownership-rehearsal suites. Any intentionally retained advisory requires a source-level reachability review and an owner-plus-coadministrator risk decision with an expiry date.

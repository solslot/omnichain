# Dependency Review

## Runtime classification

The repository deploys Solidity bytecode and has no production Node.js runtime dependencies. `npm ls --omit=dev --depth=0` is empty. Hardhat, ethers, Chainlink Solidity sources, OpenZeppelin Solidity sources, compiler tooling, coverage, and explorer plugins are development dependencies used only to build, test, and deploy.

## Automated audit result

The July 2026 npm advisory database reports transitive findings in the Hardhat/Chainlink development toolchain, including legacy cryptographic/browser polyfills and HTTP/WebSocket libraries. `npm audit fix` cannot remove all findings without breaking upgrades to the Hardhat toolbox and ethers stack. These packages are not linked into deployed EVM bytecode, but they remain relevant to the integrity of developer and deployment machines.

## Controls

- Install from the committed lockfile with `npm ci` in an isolated build environment.
- Never expose Hardhat tooling as a network service.
- Do not use untrusted RPC, source, configuration, or test inputs on the signing/deployment host.
- Build and compare bytecode in two isolated environments before deployment.
- Use a hardware-backed deployer and transfer ownership immediately to the reviewed timelock.
- Re-evaluate the Hardhat 3/toolbox 7 migration in a dedicated compatibility branch; do not use `npm audit fix --force` on the release branch.
- Re-run the dependency audit and update this review immediately before external audit freeze.

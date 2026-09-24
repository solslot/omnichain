const { expect } = require('chai');
const path = require('node:path');
const { ethers } = require('hardhat');
const {
  buildSafeAuthorityOperation, encodeAuthoritySignatures, safeTransactionArguments,
  validateAuthorityApprovalEvidence,
} = require('../scripts/lib/safe-authority-operation');
const { withArtifactHash } = require('../scripts/lib/deployment-evidence');

// Official Safe 1.4.1 artifacts, including its real EIP-1271 fallback handler.
// SAFE_CONTRACTS_ARTIFACT_ROOT supports an isolated, pinned local test install.
const artifacts = process.env.SAFE_CONTRACTS_ARTIFACT_ROOT ||
  path.join(__dirname, 'fixtures/safe-1.4.1');
async function deploy(name, args = []) {
  const artifact = require(path.join(artifacts, name));
  const [sender] = await ethers.getSigners();
  const instance = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, sender).deploy(...args);
  await instance.waitForDeployment();
  return instance;
}

describe('Authority V3 approvals against Safe 1.4.1', function () {
  for (const slot of [1, 2]) {
    it(`executes owner + identity ${slot}, rejects a signature for the wrong parent`, async function () {
      const signers = await ethers.getSigners();
      const chainId = Number((await ethers.provider.getNetwork()).chainId);
      const singleton = await deploy('Safe.sol/Safe.json');
      const handler = await deploy('handler/CompatibilityFallbackHandler.sol/CompatibilityFallbackHandler.json');
      async function safe(owners, threshold) {
        const proxy = await deploy('proxies/SafeProxy.sol/SafeProxy.json', [singleton.target]);
        const result = singleton.attach(proxy.target);
        await result.setup(owners, threshold, ethers.ZeroAddress, '0x', handler.target, ethers.ZeroAddress, 0, ethers.ZeroAddress);
        return result;
      }
      const identities = [];
      for (let i = 0; i < 3; i++) identities.push(await safe([signers[i].address], 1));
      const coadmin = await safe([identities[1].target, identities[2].target], 1);
      const root = await safe([identities[0].target, coadmin.target], 2);
      const record = (s, owners) => ({ address: s.target, owners });
      const operation = await buildSafeAuthorityOperation({
        provider: ethers.provider, chainId, phase: 'schedule', rootSafeAddress: root.target,
        rootTransaction: { to: signers[9].address, data: '0x' },
        ownerIdentitySafe: record(identities[0], [signers[0].address]),
        coadminSafe: record(coadmin, identities.slice(1).map(s => s.target)),
        coadminIdentitySafe: record(identities[slot], [signers[slot].address]),
      });
      const sealed = withArtifactHash({ schemaVersion: 2, kind: 'solslot-safe-authority-operation', chainId, phase: 'schedule', authorityOperation: operation });
      const signatures = await Promise.all(operation.approvals.map(async (approval, i) => ({
        role: approval.role,
        signature: await signers[i === 0 ? 0 : slot].signTypedData(approval.typedData.domain, approval.typedData.types, approval.typedData.message),
      })));
      const approved = validateAuthorityApprovalEvidence(sealed, {
        schemaVersion: 1, kind: 'solslot-safe-authority-approvals', phase: 'schedule',
        authorityOperationArtifactHash: sealed.artifactHash, signatures,
      });
      const args = safeTransactionArguments(operation.transaction).slice(0, 9);
      const wrongParent = approved.map(a => a.parentSafe ? { ...a, parentSafe: identities[3 - slot].target } : a);
      await expect(root.execTransaction.staticCall(...args, encodeAuthoritySignatures(wrongParent))).to.be.reverted;
      expect(await root.execTransaction.staticCall(...args, encodeAuthoritySignatures(approved))).to.equal(true);
      await root.execTransaction(...args, encodeAuthoritySignatures(approved));
      expect(await root.nonce()).to.equal(1);
    });
  }
});

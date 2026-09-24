const { readEvidence } = require('./deployment-evidence');
const { validateGovernanceEvidence } = require('./governance-deployment');
const { validateAuthorityV3GovernanceEvidence, GOVERNANCE_KIND } = require('./authority-v3-deployment');

// Dispatch by the sealed evidence schema, never by a deployment flag. Both
// implementations still check the actual contract topology and runtime hashes.
async function validatePaymentGovernance(options) {
  const evidence = readEvidence(options.path, 'governance');
  const chainId = Number((await options.provider.getNetwork()).chainId);
  if (evidence.chainId !== chainId ||
      (options.expectedChainId !== undefined && chainId !== options.expectedChainId)) {
    throw new Error('payment governance evidence differs from the selected RPC chain');
  }
  if (evidence.schemaVersion === 3 && evidence.kind === GOVERNANCE_KIND) {
    return validateAuthorityV3GovernanceEvidence(options);
  }
  if (chainId !== 84532) {
    throw new Error('Base test-asset payments require Authority V3 governance');
  }
  return validateGovernanceEvidence(options);
}

function paymentSigningSafes(governance, coadminSlot) {
  if (governance.schemaVersion !== 3) {
    return { ownerIdentitySafe: governance.safes.ownerIdentity, coadminSafe: governance.safes.coadmin };
  }
  if (![1, 2].includes(coadminSlot)) throw new Error('Select coadministrator slot 1 or 2 for this exact Safe operation');
  return {
    ownerIdentitySafe: governance.safes.identities[0],
    coadminSafe: governance.safes.coadmin,
    coadminIdentitySafe: governance.safes.identities[coadminSlot],
  };
}

function validatePaymentApprovalTopology(governance, operation) {
  const approvals = operation.approvals;
  if (!Array.isArray(approvals) || approvals.length !== 2) throw new Error('Two administrator approvals are required');
  const owner = approvals.find(a => a.role === 'owner_identity');
  const coadmin = approvals.find(a => a.role === 'coadmin');
  const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  const ownersMatch = (a, expected) => Array.isArray(a?.allowedSigners) &&
    a.allowedSigners.map(v => v.toLowerCase()).sort().join(',') === expected.map(v => v.toLowerCase()).sort().join(',');
  if (governance.schemaVersion === 3) {
    const identities = governance.safes.identities;
    const selected = identities.slice(1).find(s => equal(s.address, coadmin?.safe));
    if (!owner || !coadmin || owner.parentSafe || !equal(owner.safe, identities[0].address) ||
        !ownersMatch(owner, identities[0].owners) || !selected ||
        !equal(coadmin.parentSafe, governance.safes.coadmin.address) || !ownersMatch(coadmin, selected.owners)) {
      throw new Error('Authority V3 approval tree does not match the deployed identity Safes');
    }
  } else if (!owner || !coadmin || owner.parentSafe || coadmin.parentSafe ||
      !equal(owner.safe, governance.safes.ownerIdentity.address) ||
      !equal(coadmin.safe, governance.safes.coadmin.address) ||
      !ownersMatch(owner, governance.safes.ownerIdentity.owners) || !ownersMatch(coadmin, governance.safes.coadmin.owners)) {
    throw new Error('Legacy Safe approval tree differs from governance');
  }
}

module.exports = { validatePaymentGovernance, paymentSigningSafes, validatePaymentApprovalTopology };

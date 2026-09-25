// In-process rehearsal only. The caller supplies an isolated fork signer.
const {ethers} = require('ethers');
const {seal, validatePlan} = require('./bounded-base-deployment');
async function rehearseSequence({spec, signer, local, deployer, startNonce, sourceSha, actionEnvelopeId,
  publicBlock, auxiliaryFee}) {
  const maxPriorityFeePerGas = 1000000n;
  const dynamic = publicBlock.baseFeePerGas * 3n + maxPriorityFeePerGas;
  const maxFeePerGas = dynamic > 20000000n ? dynamic : 20000000n;
  const transactions = [], completed = [];
  const localChainId = (await local.getNetwork()).chainId;
  for (const [index, op] of spec.operations.entries()) {
    const estimate = await local.estimateGas({from: deployer, to: op.to, data: op.data, value: 0n});
    const gasLimit = (estimate * 125n + 99n) / 100n;
    const req = {type: 2, chainId: 8453n, to: op.to, data: op.data, value: 0n, nonce: startNonce + index,
      gasLimit, maxFeePerGas, maxPriorityFeePerGas, accessList: []};
    const auxiliaryFeeBudgetWei = await auxiliaryFee(req) * 3n + 100000000000n;
    const receipt = await (await signer.sendTransaction({...req, chainId: localChainId})).wait();
    if (receipt.status !== 1) throw new Error(`Fork operation ${op.name} failed`);
    if (op.to === null && receipt.contractAddress.toLowerCase() !== op.addresses[0]) throw new Error('Fork CREATE address differs');
    const created = [];
    for (const address of op.addresses) {
      const code = await local.getCode(address);
      if (code === '0x') throw new Error('Fork contract missing');
      created.push({address, runtimeCodeHash: ethers.keccak256(code)});
    }
    for (const c of op.postconditions)
      if ((await local.call({to: c.to, data: c.data, blockTag: receipt.blockNumber})).toLowerCase() !== c.result.toLowerCase())
        throw new Error(`Fork ${op.name} postcondition differs`);
    transactions.push({name: op.name, nonce: req.nonce, to: op.to, data: op.data, gasLimit: String(gasLimit),
      maxFeePerGas: String(maxFeePerGas), maxPriorityFeePerGas: String(maxPriorityFeePerGas),
      auxiliaryFeeBudgetWei: String(auxiliaryFeeBudgetWei), created, postconditions: op.postconditions});
    completed.push({name: op.name, transactionHash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: String(receipt.gasUsed)});
  }
  const plan = validatePlan(seal({schema: 'solslot.bounded-base-deployment.v2', sourceSha, actionEnvelopeId,
    chainId: 8453, chiaNetwork: 'testnet11', testOnly: true, deployer: deployer.toLowerCase(), startNonce,
    binding: spec.binding, dependencies: spec.dependencies, transactions,
    totalBudgetWei: String(transactions.reduce((sum, t) => sum + BigInt(t.gasLimit) * BigInt(t.maxFeePerGas) + BigInt(t.auxiliaryFeeBudgetWei), 0n))}));
  return {plan, completed};
}

module.exports = {rehearseSequence};

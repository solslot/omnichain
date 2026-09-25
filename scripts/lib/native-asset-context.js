const path = require('node:path');
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const {ethers} = require('ethers');
const {readEvidence, sha256} = require('./deployment-evidence');
const {check} = require('./bounded-base-deployment');
const {validateWarpPortalEvidence} = require('./warp-portal-deployment');
const {validateTestAssetRecord} = require('./test-asset-evidence');
const {assetBridgeSpec} = require('./native-asset-deployment');

function readChiaConfirmation(file, expectedHash) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let record;
  try {
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.size > 0 && stat.size < 128 * 1024, 'bounded Chia confirmation required');
    record = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally {fs.closeSync(fd);}
  const {manifestHash, ...body} = record;
  check(manifestHash === expectedHash && manifestHash === sha256(body), 'Chia confirmation artifact hash differs');
  return record;
}

async function loadAssetContext({settings, providers, deployer, nonce}) {
  const base = readEvidence(settings.basePortalPath);
  const chia = readChiaConfirmation(settings.chiaPortalPath, settings.chiaPortalHash);
  check(base.artifactHash === settings.basePortalHash && chia.manifestHash === settings.chiaPortalHash,
    'pinned portal artifacts differ');
  check(base.sourceSha === settings.basePortalSourceSha, 'original portal source differs');
  const tokens = settings.tokenPaths.map(p => readEvidence(p));
  check(tokens.length === 2 && tokens[0].fixture === 'TEST-USDC' && tokens[1].fixture === 'TEST-USDT',
    'ordered test-token evidence required');
  for (const provider of providers) {
    await validateWarpPortalEvidence({path: settings.basePortalPath, provider,
      expectedPortal: base.portal.address, expectedOmnichainSourceSha: settings.basePortalSourceSha,
      expectedRosterArtifactHash: settings.rosterHash, expectedValidatorAddresses: settings.validatorAddresses,
      expectedChainId: 8453});
    for (const record of tokens) await validateTestAssetRecord({provider, record,
      expectedToken: record.address, allowedFixtures: ['TEST-USDC', 'TEST-USDT']});
  }
  const bridge = ethers.getCreateAddress({from: deployer, nonce}).toLowerCase();
  const derived = JSON.parse(execFileSync(settings.python, ['-I', path.resolve(__dirname, '../derive-native-asset-routes.py')], {
    input: JSON.stringify({...settings, chiaPortal: chia, bridge, tokens: tokens.map(t => t.address.toLowerCase())}),
    encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024,
  }));
  const artifact = require('../../artifacts/contracts/SolslotTestAssetBridge.sol/SolslotTestAssetBridge.json');
  const spec = await assetBridgeSpec({deployer, nonce, governance: base.safe.address,
    transferLimitMojos: settings.transferLimitMojos, outstandingLimitMojos: settings.outstandingLimitMojos,
    maxMessageTollWei: settings.maxMessageTollWei, artifact, basePortal: base, basePortalHash: settings.basePortalHash,
    chiaPortal: chia, chiaPortalHash: settings.chiaPortalHash, routes: derived.routes,
    expectedSamuelSha: settings.samuelSourceSha, expectedTokens: tokens.map(t => t.address)});
  check(tokens[0].runtimeCodeHash === tokens[1].runtimeCodeHash, 'fixture runtime hashes differ');
  const dependencies = [
    ...tokens.map(t => ({address: t.address, runtimeCodeHash: t.runtimeCodeHash})),
    {address: base.portal.address, runtimeCodeHash: base.runtimeCodeHashes.portal},
    {address: base.proxy.implementation, runtimeCodeHash: base.runtimeCodeHashes.implementation},
    {address: base.proxy.admin, runtimeCodeHash: base.runtimeCodeHashes.proxyAdmin},
    {address: base.safe.address, runtimeCodeHash: base.runtimeCodeHashes.safe},
  ];
  return {...spec, artifact, dependencies, routes: derived.routes, chiaObservation: derived.observation,
    tokenRuntimeHash: tokens[0].runtimeCodeHash};
}
module.exports = {loadAssetContext, readChiaConfirmation};

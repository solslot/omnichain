"""Verify signed genesis and independent Chia observations before SOLS deployment.

Read-only: no wallet client, keys, signing, database or transaction submission.
"""
import asyncio
import json
import os
from pathlib import Path
import stat
import subprocess
import sys


def check(condition, message):
    if not condition:
        raise ValueError(message)


def checked_source(root_value, expected):
    root = Path(root_value).resolve(strict=True)
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
    check(git('rev-parse', 'HEAD') == expected and not git('status', '--porcelain'),
          'Route derivation requires a clean exact source checkout')
    return root


def read_bounded_artifact(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        check(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= 2 * 1024 * 1024, 'Invalid signed genesis file')
        with os.fdopen(fd, closefd=False) as stream:
            return json.load(stream)
    finally:
        os.close(fd)


def verify_genesis(artifact, settings):
    from eth_account.messages import encode_typed_data
    from eth_keys import keys
    from eth_keys.exceptions import BadSignature
    from eth_utils import keccak
    from chia.types.blockchain_format.coin import Coin
    from chia_rs.sized_ints import uint64
    from solslot_puzzles.artifact_schema_v4 import verify_public_artifact, artifact_signing_typed_data, _rebuild_plan
    from solslot_puzzles.eligibility_policy import identity_policy_from_artifact
    from solslot_puzzles.genesis_ceremony_rc23 import build_rc23_sgt_issuance

    def signature_verifier(payload, index, public_key, signature):
        del index
        try:
            signable = encode_typed_data(full_message=artifact_signing_typed_data(payload))
            digest = keccak(b'\x19' + bytes(signable.version) + signable.header + signable.body)
            v = signature[64]
            if v >= 27:
                v -= 27
            recovered = keys.Signature(vrs=(v, int.from_bytes(signature[:32], 'big'),
                                           int.from_bytes(signature[32:64], 'big'))).recover_public_key_from_msg_hash(digest)
            return recovered.to_compressed_bytes() == public_key
        except (ValueError, TypeError, IndexError, BadSignature):
            return False

    check(artifact.get('artifactHash') == settings['genesisHash'], 'Exact fresh genesis artifact required')
    verify_public_artifact(artifact, signature_verifier=signature_verifier)
    check(artifact['network'] == 'testnet11' and artifact.get('paymentChainId') == 8453 and
          artifact['evmChainId'] == 11155111 and identity_policy_from_artifact(artifact) is not None,
          'Fresh Base/Testnet11 genesis with the real age-plus-sanctions policy required')
    sources = artifact['genesisPlan']['sourceShas']
    for name in ['protocol', 'samuel', 'omnichain']:
        check(sources[name] == settings[name + 'SourceSha'], 'Genesis source binding differs')
    plan = _rebuild_plan(artifact)
    surfaces = [(plan.protocol.pool_launcher_id, plan.protocol.pool_full_puzzle_hash, 1),
                (plan.protocol.did_launcher_id, plan.protocol.did_full_puzzle_hash, 1),
                (plan.protocol.governance_launcher_id, plan.protocol.governance_full_puzzle_hash, 1),
                (plan.statutes.launcher_id, plan.statutes.full_puzzle_hash, 1),
                (plan.protocol_config.launcher_id, plan.protocol_config.full_puzzle_hash, 1),
                (plan.admin_authority.launcher_id, plan.admin_authority.full_puzzle_hash, 1),
                (plan.vault_version_registry.launcher_id, plan.vault_version_registry.full_puzzle_hash, 1),
                (plan.property_registry.launcher_id, plan.property_registry.full_puzzle_hash, 1)]
    surfaces.extend((v.launcher_id, v.full_puzzle_hash, v.launcher_amount) for v in plan.admin_authority_v3.identity_vaults)
    outputs = [Coin(parent, puzzle, uint64(amount)).name() for parent, puzzle, amount in surfaces]
    outputs += [build_rc23_sgt_issuance(plan).reserve_coin.name(), plan.protocol.sols_reserve_seed_coin_id]
    outputs.extend(c.name() for c in plan.bridge_batch.bridge_coins)
    return {'nativeSolsAssetId': '0x' + plan.protocol.sols_tail_hash.hex(),
            'height': artifact['ceremony']['confirmedBlockIndex'],
            'inputs': list(artifact['genesisPlan']['fundingCoinIds'].values()),
            'outputs': ['0x' + coin.hex() for coin in outputs]}


async def verify_chain_genesis(nodes, projection):
    from chia_rs.sized_bytes import bytes32
    height = projection['height']
    observations = []
    for node in nodes:
        check((await node.get_network_info()).get('network_name') == 'testnet11', 'Wrong genesis observation network')
        state = await node.get_blockchain_state()
        peak = state.get('peak')
        check(state.get('sync', {}).get('synced') is True and peak is not None and peak.height - height + 1 >= 12,
              'Genesis observation requires twelve confirmations on a synced node')
        block = await node.get_block_record_by_height(height)
        check(block is not None, 'Genesis block unavailable')
        for group in ['inputs', 'outputs']:
            for coin_id in projection[group]:
                name = bytes32.from_hexstr(coin_id)
                record = await node.get_coin_record_by_name(name)
                check(record is not None and record.coin.name() == name, 'Genesis coin missing or mismatched')
                actual = record.spent_block_index if group == 'inputs' else record.confirmed_block_index
                check(actual == height, 'Genesis coin confirmation differs')
        again = await node.get_block_record_by_height(height)
        check(again is not None and again.header_hash == block.header_hash, 'Genesis observation reorganized')
        observations.append({'height': height, 'blockHash': '0x' + block.header_hash.hex(), 'observedHeight': peak.height})
    check(len(observations) == 2 and observations[0]['blockHash'] == observations[1]['blockHash'], 'Genesis providers disagree')
    return observations


async def main():
    settings = json.load(sys.stdin)
    protocol = checked_source(settings['protocolRoot'], settings['protocolSourceSha'])
    samuel = checked_source(settings['samuelRoot'], settings['samuelSourceSha'])
    sys.path[:0] = [str(protocol), str(samuel)]
    os.chdir(samuel)
    from chia.full_node.full_node_rpc_client import FullNodeRpcClient
    from chia.util.config import load_config
    from chia_rs import G1Element
    from chia_rs.sized_bytes import bytes32
    from chia_rs.sized_ints import uint16
    from commands.http_full_node_rpc_client import HTTPFullNodeRpcClient
    from drivers.solslot_portal_observer import observe_portal
    from drivers.solslot_native_sols_route import derive_native_sols_route

    projection = verify_genesis(read_bounded_artifact(settings['genesisPath']), settings)
    rpc_root = Path(settings['chiaRpcRoot'])
    nodes = []
    try:
        nodes.append(await FullNodeRpcClient.create('localhost', uint16(settings['chiaRpcPort']), rpc_root, load_config(rpc_root, 'config.yaml')))
        nodes.append(HTTPFullNodeRpcClient('https://testnet11.api.coinset.org'))
        observations = await verify_chain_genesis(nodes, projection)
        portal = settings['chiaPortal']
        kwargs = dict(launcher_id=bytes32.from_hexstr(portal['spend']['launcherId']),
                      public_keys=[G1Element.from_bytes(bytes.fromhex(k[2:])) for k in portal['validatorRoster']['blsPublicKeys']],
                      update_puzzle_hash=bytes32.from_hexstr(portal['spend']['updatePuzzleHash']))
        snapshots = [await observe_portal(node, **kwargs) for node in nodes]
        check(snapshots[0].coin.name() == snapshots[1].coin.name() and snapshots[0].used_messages == snapshots[1].used_messages,
              'Chia portal providers disagree')
        blocks = [await node.get_block_record_by_height(portal['spend']['confirmationHeight']) for node in nodes]
        check(all(b is not None and '0x' + b.header_hash.hex() == portal['providerAgreement']['confirmationBlockHash'] for b in blocks),
              'Chia portal confirmation is no longer canonical')
        route = derive_native_sols_route(portal_launcher_id=portal['spend']['launcherId'], wrapped_sols=settings['wrappedSols'],
            native_sols_asset_id=projection['nativeSolsAssetId'], genesis_artifact_hash=settings['genesisHash'], source_sha=settings['samuelSourceSha'])
        print(json.dumps({'route': route, 'genesisObservations': observations,
                          'portalCoinId': '0x' + snapshots[0].coin.name().hex()}))
    finally:
        for node in nodes:
            node.close()
            await node.await_closed()


if __name__ == '__main__':
    asyncio.run(main())

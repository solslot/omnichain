"""Read both Chia providers and derive routes from an exact clean Samuel tree.

No wallet, signing key, transaction submission, or mutable cursor is used.
"""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys


async def main():
    settings = json.load(sys.stdin)
    root = Path(settings['samuelRoot']).resolve(strict=True)
    sha = settings['samuelSourceSha']
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
    if git('rev-parse', 'HEAD') != sha or git('status', '--porcelain'):
        raise ValueError('Samuel must match the clean pinned route source')
    os.chdir(root)
    sys.path.insert(0, str(root))
    from chia.full_node.full_node_rpc_client import FullNodeRpcClient
    from chia.util.config import load_config
    from chia_rs import G1Element
    from chia_rs.sized_bytes import bytes32
    from chia_rs.sized_ints import uint16
    from commands.http_full_node_rpc_client import HTTPFullNodeRpcClient
    from drivers.solslot_portal_observer import observe_portal
    from drivers.solslot_test_asset_route import derive_test_asset_route

    evidence = settings['chiaPortal']
    rpc_root = Path(settings['chiaRpcRoot'])
    config = load_config(rpc_root, 'config.yaml')
    # The first provider is the operator's authenticated node. The second is
    # the public Testnet11 provider, not a second alias for that same node.
    nodes = [await FullNodeRpcClient.create('localhost', uint16(settings['chiaRpcPort']), rpc_root, config),
             HTTPFullNodeRpcClient('https://testnet11.api.coinset.org')]
    try:
        kwargs = dict(launcher_id=bytes32.from_hexstr(evidence['spend']['launcherId']),
                      public_keys=[G1Element.from_bytes(bytes.fromhex(k[2:])) for k in evidence['validatorRoster']['blsPublicKeys']],
                      update_puzzle_hash=bytes32.from_hexstr(evidence['spend']['updatePuzzleHash']))
        snapshots = [await observe_portal(node, **kwargs) for node in nodes]
        expected_coin = evidence['spend']['initialPortalCoinId']
        if any('0x' + s.coin.name().hex() != expected_coin or s.used_messages for s in snapshots):
            raise ValueError('Initial portal state has changed; reconcile before escrow deployment')
        height = evidence['spend']['confirmationHeight']
        blocks = [await node.get_block_record_by_height(height) for node in nodes]
        if any(b is None or '0x' + b.header_hash.hex() != evidence['providerAgreement']['confirmationBlockHash'] for b in blocks):
            raise ValueError('Chia portal confirmation is no longer canonical')
        routes = [derive_test_asset_route(portal_launcher_id=evidence['spend']['launcherId'],
                   erc20_bridge=settings['bridge'], token=token, fixture=fixture, source_sha=sha)
                  for token, fixture in zip(settings['tokens'], ['TEST-USDC', 'TEST-USDT'])]
        print(json.dumps({'routes': routes, 'observation': {'portalCoinId': expected_coin,
              'confirmationHeight': height, 'confirmationBlockHash': evidence['providerAgreement']['confirmationBlockHash'],
              'providers': [{'height': s.height, 'headerHash': '0x' + s.header_hash.hex()} for s in snapshots]}}))
    finally:
        for node in nodes:
            node.close()
            await node.await_closed()


if __name__ == '__main__':
    asyncio.run(main())

"""Run with the pinned protocol on PYTHONPATH and the bridge Python runtime."""
import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_keys import keys
from chia_rs.sized_bytes import bytes32
from solslot_puzzles.artifact_schema_v4 import artifact_signing_typed_data
from solslot_puzzles.eligibility_policy import ELIGIBILITY_POLICY
from tests import test_genesis_ceremony_rc23 as fixtures
from tests.test_eligibility_policy import new_plan
from tests.test_signed_payment_chain import artifact

loader = importlib.util.spec_from_file_location('native_sols_derivation', Path(__file__).parents[1] / 'scripts/derive-native-sols-route.py')
subject = importlib.util.module_from_spec(loader)
loader.loader.exec_module(subject)


def signed_genesis(monkeypatch, policy=ELIGIBILITY_POLICY):
    # Public test keys only. Real signatures exercise typed-data and roster checks.
    private_keys = [bytes([i]) * 32 for i in [1, 2, 3]]
    pubkeys = tuple(keys.PrivateKey(k).public_key.to_compressed_bytes() for k in private_keys)
    monkeypatch.setattr(fixtures, 'ADMIN_KEYS', pubkeys)
    plan = new_plan(monkeypatch, policy)
    value = artifact(plan)
    signable = encode_typed_data(full_message=artifact_signing_typed_data(value))
    value['signatures'] = [dict(adminIndex=i, compressedPubkey='0x'+pubkeys[i].hex(),
        signature='0x'+bytes(Account.sign_message(signable, private_keys[i]).signature).hex()) for i in [0, 2]]
    settings = {k+'SourceSha': value['genesisPlan']['sourceShas'][k] for k in ['protocol', 'samuel', 'omnichain']}
    settings['genesisHash'] = value['artifactHash']
    return value, settings


def test_actual_owner_and_coadmin_signatures_derive_the_full_genesis(monkeypatch):
    value, settings = signed_genesis(monkeypatch)
    projection = subject.verify_genesis(value, settings)
    assert projection['nativeSolsAssetId'] == value['solsTailHash']
    assert len(projection['inputs']) == 9
    assert len(projection['outputs']) == 45
    assert projection['height'] == 1234


@pytest.mark.parametrize('mutation', ['signature', 'source', 'artifact', 'roster'])
def test_invalid_signature_or_different_genesis_is_refused(monkeypatch, mutation):
    value, settings = signed_genesis(monkeypatch)
    if mutation == 'signature': value['signatures'][0]['signature'] = '0x'+'00'*65
    if mutation == 'source': settings['samuelSourceSha'] = 'f'*40
    if mutation == 'artifact': settings['genesisHash'] = '0x'+'ff'*32
    if mutation == 'roster': value['signatures'][0]['adminIndex'] = 1
    with pytest.raises(ValueError): subject.verify_genesis(value, settings)


def test_historical_age_only_artifact_cannot_launch_new_sols(monkeypatch):
    value, settings = signed_genesis(monkeypatch, None)
    with pytest.raises(ValueError, match='age-plus-sanctions'): subject.verify_genesis(value, settings)


class Node:
    def __init__(self, projection, *, confirmations=12, block_hash=b'\x11'*32, wrong_coin=False, wrong_spend=False, reorg=False):
        self.p = projection; self.confirmations = confirmations; self.block_hash = block_hash
        self.wrong_coin = wrong_coin; self.wrong_spend = wrong_spend; self.reorg = reorg; self.reads = 0
    async def get_network_info(self): return {'network_name': 'testnet11'}
    async def get_blockchain_state(self):
        return {'sync': {'synced': True}, 'peak': SimpleNamespace(height=self.p['height']+self.confirmations-1)}
    async def get_block_record_by_height(self, height):
        self.reads += 1
        return SimpleNamespace(header_hash=bytes32(b'\x33'*32 if self.reorg and self.reads > 1 else self.block_hash))
    async def get_coin_record_by_name(self, name):
        return SimpleNamespace(coin=SimpleNamespace(name=lambda: bytes32(b'\xff'*32) if self.wrong_coin else name),
            spent_block_index=self.p['height']+(1 if self.wrong_spend else 0), confirmed_block_index=self.p['height'])


@pytest.mark.parametrize('case', ['valid', 'shallow', 'disagree', 'wrong_coin', 'wrong_spend', 'reorg'])
def test_chain_observation_requires_matching_exact_coins_and_stable_confirmation(case):
    p = {'height': 1234, 'inputs': ['0x'+'01'*32], 'outputs': ['0x'+'02'*32]}
    options = {'shallow': {'confirmations': 11}, 'disagree': {'block_hash': b'\x22'*32},
               'wrong_coin': {'wrong_coin': True}, 'wrong_spend': {'wrong_spend': True}, 'reorg': {'reorg': True}}
    nodes = [Node(p), Node(p, **options.get(case, {}))]
    if case == 'valid': assert len(asyncio.run(subject.verify_chain_genesis(nodes, p))) == 2
    else:
        with pytest.raises(ValueError): asyncio.run(subject.verify_chain_genesis(nodes, p))

const {expect} = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {sha256} = require('../scripts/lib/deployment-evidence');
const {readChiaConfirmation} = require('../scripts/lib/native-asset-context');

describe('Chia escrow confirmation input', function () {
  let directory;
  beforeEach(() => {directory = fs.mkdtempSync(path.join(os.tmpdir(), 'solslot-chia-evidence-'));});
  afterEach(() => {fs.rmSync(directory, {recursive: true, force: true});});
  it('preserves the original indented receipt and validates its canonical manifest hash', function () {
    const body = {network: 'testnet11', confirmed: true, spend: {launcherId: 'original'}};
    const record = {...body, manifestHash: sha256(body)}, file = path.join(directory, 'receipt.json');
    const original = JSON.stringify(record, null, 2);
    fs.writeFileSync(file, original);
    expect(readChiaConfirmation(file, record.manifestHash)).to.deep.equal(record);
    expect(fs.readFileSync(file, 'utf8')).to.equal(original);
    fs.writeFileSync(file, JSON.stringify({...record, confirmed: false}));
    expect(() => readChiaConfirmation(file, record.manifestHash)).to.throw('hash differs');
  });
  it('rejects an unpinned receipt or a symlink substitution', function () {
    const record = {confirmed: true, manifestHash: sha256({confirmed: true})};
    const file = path.join(directory, 'receipt.json'), link = path.join(directory, 'link.json');
    fs.writeFileSync(file, JSON.stringify(record)); fs.symlinkSync(file, link);
    expect(() => readChiaConfirmation(file, '0x' + '0'.repeat(64))).to.throw('hash differs');
    expect(() => readChiaConfirmation(link, record.manifestHash)).to.throw();
  });
});

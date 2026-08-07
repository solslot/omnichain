const { expect } = require("chai");

const {
  resolveListener,
} = require("../scripts/serve-launch-rehearsal");

describe("launch rehearsal service listener", function () {
  it("defaults to the isolated loopback staging port", function () {
    expect(resolveListener({})).to.deep.equal({
      host: "127.0.0.1",
      port: 8794,
    });
  });

  it("rejects the Key of Solomon port", function () {
    expect(() => resolveListener({
      SOLSLOT_LAUNCH_REHEARSAL_PORT: "8793",
    })).to.throw("port 8793 is reserved for Key of Solomon");
  });

  it("rejects public listeners and invalid ports", function () {
    expect(() => resolveListener({
      SOLSLOT_LAUNCH_REHEARSAL_HOST: "0.0.0.0",
    })).to.throw("must bind to loopback");
    expect(() => resolveListener({
      SOLSLOT_LAUNCH_REHEARSAL_PORT: "not-a-port",
    })).to.throw("port is invalid");
  });
});

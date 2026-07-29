const http = require("node:http");
const { ethers } = require("ethers");

const {
  LaunchRehearsalCoordinator,
  loadCoordinatorConfig,
  loadCoordinatorSecrets,
} = require("./lib/launch-rehearsal-coordinator");

const MAX_BODY_BYTES = 64 * 1024;

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  if (!length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function authorized(request, token) {
  const header = String(request.headers.authorization || "");
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const left = Buffer.from(supplied);
  const right = Buffer.from(token);
  return left.length === right.length && left.length > 0
    && require("node:crypto").timingSafeEqual(left, right);
}

async function main(environment = process.env) {
  const host = String(environment.SOLSLOT_LAUNCH_REHEARSAL_HOST || "127.0.0.1");
  const port = Number(environment.SOLSLOT_LAUNCH_REHEARSAL_PORT || 8793);
  if (!["127.0.0.1", "::1"].includes(host)) {
    throw new Error("launch rehearsal service must bind to loopback");
  }
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error("launch rehearsal port is invalid");
  }
  const rpcUrl = String(environment.SOLSLOT_LAUNCH_REHEARSAL_RPC_URL || "");
  if (!rpcUrl.startsWith("https://")) {
    throw new Error("SOLSLOT_LAUNCH_REHEARSAL_RPC_URL must use HTTPS");
  }
  const stateDirectory = String(environment.SOLSLOT_LAUNCH_REHEARSAL_STATE_DIR || "");
  if (!stateDirectory) {
    throw new Error("SOLSLOT_LAUNCH_REHEARSAL_STATE_DIR is required");
  }
  const config = loadCoordinatorConfig(environment);
  const secrets = loadCoordinatorSecrets(environment);
  const provider = new ethers.JsonRpcProvider(rpcUrl, config.activation.chainId, {
    staticNetwork: true,
  });
  const coordinator = new LaunchRehearsalCoordinator({
    config,
    secrets,
    stateDirectory,
    provider,
  });
  await coordinator.verifyRuntime();

  const server = http.createServer(async (request, response) => {
    try {
      if (request.url === "/health" && request.method === "GET") {
        await coordinator.verifyRuntime();
        send(response, 200, {
          healthy: true,
          configHash: config.configHash,
          releaseTag: config.releaseTag,
        });
        return;
      }
      if (!authorized(request, secrets.serviceToken)) {
        send(response, 401, { detail: "authentication required" });
        return;
      }
      const url = new URL(request.url, "http://localhost");
      if (request.method === "POST" && url.pathname === "/v1/rehearsals") {
        send(response, 200, await coordinator.start(await readBody(request)));
        return;
      }
      const match = url.pathname.match(/^\/v1\/rehearsals\/(rehearsal_[0-9a-f]{64})(?:\/transactions)?$/);
      if (!match) {
        send(response, 404, { detail: "not found" });
        return;
      }
      if (request.method === "GET" && !url.pathname.endsWith("/transactions")) {
        send(response, 200, await coordinator.get(match[1]));
        return;
      }
      if (request.method === "POST" && url.pathname.endsWith("/transactions")) {
        const body = await readBody(request);
        if (!body || Object.keys(body).length !== 1 || !body.transactionHash) {
          throw new Error("transaction submission fields are invalid");
        }
        send(
          response,
          200,
          await coordinator.submit(match[1], body.transactionHash),
        );
        return;
      }
      send(response, 405, { detail: "method not allowed" });
    } catch (error) {
      send(response, 409, { detail: error.message });
    }
  });
  server.listen(port, host, () => {
    console.log(JSON.stringify({
      service: "solslot-launch-rehearsal",
      host,
      port,
      configHash: config.configHash,
      releaseTag: config.releaseTag,
    }));
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { authorized, main, readBody, send };

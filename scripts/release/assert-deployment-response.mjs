import { Buffer } from "node:buffer";
import process from "node:process";

const DEPLOYMENT_ID = /^[a-z0-9][a-z0-9._-]{7,63}$/;
const MAX_RESPONSE_BYTES = 4096;

async function assertResponse() {
  const expected = process.env.EXPECTED_DEPLOYMENT_ID;
  if (typeof expected !== "string" || !DEPLOYMENT_ID.test(expected)) {
    throw new Error("DEPLOYMENT_IDENTITY_MISMATCH");
  }

  let response = "";
  for await (const chunk of process.stdin) {
    response += chunk;
    if (Buffer.byteLength(response, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("DEPLOYMENT_IDENTITY_MISMATCH");
    }
  }

  let body;
  try {
    body = JSON.parse(response);
  } catch {
    throw new Error("DEPLOYMENT_IDENTITY_MISMATCH");
  }
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    body.deploymentId !== expected
  ) {
    throw new Error("DEPLOYMENT_IDENTITY_MISMATCH");
  }
}

assertResponse().catch(() => {
  process.stderr.write("DEPLOYMENT_IDENTITY_MISMATCH\n");
  process.exitCode = 1;
});

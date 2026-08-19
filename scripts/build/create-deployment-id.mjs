/* global process */

import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEPLOYMENT_ID_PATH = '/app/deployment-id';

function validatedDeploymentId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{7,63}$/.test(value)) {
    throw new Error('DEPLOYMENT_ID_INVALID');
  }
  return value;
}

export async function writeDeploymentId(value, writeFileImpl = writeFile) {
  const deploymentId = validatedDeploymentId(value);
  await writeFileImpl(DEPLOYMENT_ID_PATH, `${deploymentId}\n`, {
    encoding: 'utf8',
    mode: 0o444,
    flag: 'wx'
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv.length !== 3) throw new Error('DEPLOYMENT_ID_INVALID');
    await writeDeploymentId(process.argv[2]);
  } catch {
    process.stderr.write('DEPLOYMENT_ID_INVALID\n');
    process.exitCode = 1;
  }
}

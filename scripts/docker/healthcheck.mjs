import { getHealthcheckUrl } from './healthcheck-url.mjs';

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 4_000);

try {
  const response = await fetch(getHealthcheckUrl(), {
    signal: controller.signal
  });
  if (!response.ok) process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}

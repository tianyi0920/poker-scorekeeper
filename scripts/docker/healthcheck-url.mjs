export function getHealthcheckUrl(environment = process.env) {
  const port = environment.PORT?.trim() || '80';
  return `http://127.0.0.1:${port}/api/health/ready`;
}

import { URL } from 'node:url';

export const CI_TEST_DATABASE_URL = 'mysql://poker_ci:poker_ci@127.0.0.1:3306/poker_scorekeeper_ci_test';
export const CI_TEST_DATABASE_TARGET_REFUSED = 'CI_TEST_DATABASE_TARGET_REFUSED';

function refused() {
  const error = new Error(CI_TEST_DATABASE_TARGET_REFUSED);
  error.code = CI_TEST_DATABASE_TARGET_REFUSED;
  return error;
}

/**
 * Validate the complete environment boundary used by GitHub Actions tests.
 * This function deliberately does not load dotenv files or inspect the host.
 */
export function validateCiTestEnvironment(environment) {
  if (environment?.CI !== 'true' || environment?.GITHUB_ACTIONS !== 'true') {
    throw refused();
  }

  const configuredUrl = environment?.DATABASE_URL;
  if (configuredUrl !== CI_TEST_DATABASE_URL) {
    throw refused();
  }

  let target;
  try {
    target = new URL(configuredUrl);
  } catch {
    throw refused();
  }

  if (
    target.protocol !== 'mysql:'
    || target.hostname !== '127.0.0.1'
    || target.host !== '127.0.0.1:3306'
    || target.pathname !== '/poker_scorekeeper_ci_test'
    || target.username !== 'poker_ci'
    || target.password !== 'poker_ci'
    || target.search !== ''
    || target.hash !== ''
    || target.href !== CI_TEST_DATABASE_URL
  ) {
    throw refused();
  }

  return CI_TEST_DATABASE_URL;
}

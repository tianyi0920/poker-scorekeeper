export const CI_TEST_DATABASE_URL =
  'mysql://poker_ci:poker_ci@127.0.0.1:3306/poker_scorekeeper_ci_test';
export const TEST_DATABASE_TARGET_REFUSED = 'TEST_DATABASE_TARGET_REFUSED';

interface TestEnvironment {
  CI?: string;
  GITHUB_ACTIONS?: string;
  DATABASE_URL?: string;
}

function refused(): never {
  throw new Error(TEST_DATABASE_TARGET_REFUSED);
}

export function requireAuthorizedTestDatabase(
  environment: TestEnvironment = process.env
): URL {
  const configuredUrl = environment.DATABASE_URL;
  if (configuredUrl === undefined || /%[0-9a-f]{2}/i.test(configuredUrl)) refused();

  let target: URL;
  try {
    target = new URL(configuredUrl);
  } catch {
    refused();
  }

  const hasCiMarker = environment.CI === 'true' || environment.GITHUB_ACTIONS === 'true';
  if (hasCiMarker) {
    if (
      environment.CI !== 'true'
      || environment.GITHUB_ACTIONS !== 'true'
      || configuredUrl !== CI_TEST_DATABASE_URL
      || target.href !== CI_TEST_DATABASE_URL
    ) {
      refused();
    }
    return target;
  }

  if (
    target.protocol !== 'mysql:'
    || target.hostname !== 'tianyi.wiki'
    || target.host !== 'tianyi.wiki:8306'
    || target.pathname !== '/poker_scorekeeper_test'
    || target.username === ''
    || target.password === ''
    || target.search !== ''
    || target.hash !== ''
    || target.href !== configuredUrl
  ) {
    refused();
  }
  return target;
}

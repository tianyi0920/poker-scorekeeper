export type FixtureRole =
  | 'super-admin'
  | 'admin'
  | 'admin-2'
  | 'player-a'
  | 'player-b'
  | 'outsider'
  | 'forced-password';

const runId = process.env.TASK18_RUN_ID ?? 'task18-red';
const nicknameSuffix = runId.slice(-6);

export const accounts = {
  'super-admin': {
    id: `${runId}sa`,
    username: `${runId}-super`,
    nickname: `超管${nicknameSuffix}`,
    password: 'Task18-only-super-12345',
    role: 'SUPER_ADMIN'
  },
  admin: {
    id: `${runId}ad`,
    username: `${runId}-admin`,
    nickname: `管理员${nicknameSuffix}`,
    password: 'Task18-only-admin-12345',
    role: 'ADMIN'
  },
  'admin-2': {
    id: `${runId}a2`,
    username: `${runId}-admin2`,
    nickname: `管理员乙${nicknameSuffix}`,
    password: 'Task18-only-admin-2-12345',
    role: 'ADMIN'
  },
  'player-a': {
    id: `${runId}pa`,
    username: `${runId}-player-a`,
    nickname: `玩家甲${nicknameSuffix}`,
    password: 'Task18-only-player-a-12345',
    role: 'USER'
  },
  'player-b': {
    id: `${runId}pb`,
    username: `${runId}-player-b`,
    nickname: `玩家乙${nicknameSuffix}`,
    password: 'Task18-only-player-b-12345',
    role: 'USER'
  },
  outsider: {
    id: `${runId}ou`,
    username: `${runId}-outsider`,
    nickname: `局外人${nicknameSuffix}`,
    password: 'Task18-only-outsider-12345',
    role: 'USER'
  },
  'forced-password': {
    id: `${runId}fp`,
    username: `${runId}-forced`,
    nickname: `初始密码${nicknameSuffix}`,
    password: 'Task18-only-forced-12345',
    role: 'USER'
  }
} as const;

export const tablePlayers = Array.from({ length: 12 }, (_, index) => {
  const ordinal = String(index + 1).padStart(2, '0');
  return {
    id: `${runId}t${ordinal}`,
    username: `${runId}-t${ordinal}`,
    nickname: `十二人${ordinal}${nicknameSuffix}`,
    password: `Task18-only-table-${ordinal}-12345`,
    role: 'USER' as const
  };
});

export const allFixtureAccounts = [...Object.values(accounts), ...tablePlayers];

export function fixtureAccount(role: FixtureRole) {
  return accounts[role];
}

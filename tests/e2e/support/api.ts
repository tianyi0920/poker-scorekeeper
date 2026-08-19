import { expect, request, type APIRequestContext, type APIResponse } from '@playwright/test';
import { createHash } from 'node:crypto';
import { accounts, fixtureAccount, type FixtureRole } from './fixtures.js';

export interface ApiSession {
  context: APIRequestContext;
  csrfToken: string;
  user: { id: string; role: string; nickname: string };
}

export async function apiLoginAccount(
  account: { username: string; password: string },
  baseURL = 'http://127.0.0.1:3000'
): Promise<ApiSession> {
  const context = await request.newContext({ baseURL });
  const response = await context.post('/api/auth/login', {
    data: { username: account.username, password: account.password }
  });
  expect(response.status(), `API login for ${account.username}`).toBe(201);
  const body = await response.json() as {
    csrfToken: string;
    user: { id: string; role: string; nickname: string };
  };
  return { context, csrfToken: body.csrfToken, user: body.user };
}

export function apiLogin(role: FixtureRole): Promise<ApiSession> {
  return apiLoginAccount(fixtureAccount(role));
}

export function apiWrite(
  session: ApiSession,
  method: 'post' | 'put' | 'patch' | 'delete',
  path: string,
  data?: unknown
): Promise<APIResponse> {
  return session.context[method](path, {
    headers: { 'X-CSRF-Token': session.csrfToken },
    ...(data === undefined ? {} : { data })
  });
}

export async function createStartedGame(
  session: ApiSession,
  suffix: string,
  handPrice = '300',
  onGameCreated?: (gameId: string) => void
): Promise<{ id: string; name: string }> {
  const name = `Task18 ${suffix} ${Date.now().toString(36)}`;
  const created = await apiWrite(session, 'post', '/api/games', {
    name,
    handPrice,
    rakeEnabled: true
  });
  expect(created.status(), `create ${suffix}`).toBe(201);
  const game = await created.json() as { id: string; name: string };
  onGameCreated?.(game.id);
  const started = await apiWrite(session, 'post', `/api/games/${encodeURIComponent(game.id)}/start`);
  expect(started.status(), `start ${suffix}`).toBe(200);
  return game;
}

export async function apiBuyHands(
  session: ApiSession,
  gameId: string,
  hands: number,
  key: string
): Promise<APIResponse> {
  const suffix = createHash('sha256').update(key).digest('hex').slice(0, 20);
  return apiWrite(session, 'post', `/api/games/${encodeURIComponent(gameId)}/buyins`, {
    hands,
    idempotencyKey: `${process.env.TASK18_RUN_ID}-${suffix}`
  });
}

export async function prepareBalancedSettlement(
  admin: ApiSession,
  playerA: ApiSession,
  playerB: ApiSession,
  suffix: string,
  onGameCreated?: (gameId: string) => void
) {
  const game = await createStartedGame(admin, suffix, '300', onGameCreated);
  expect((await apiBuyHands(playerA, game.id, 3, `${suffix}-buy-a`)).status()).toBe(201);
  expect((await apiBuyHands(playerB, game.id, 3, `${suffix}-buy-b`)).status()).toBe(201);
  expect((await apiBuyHands(admin, game.id, 4, `${suffix}-buy-admin`)).status()).toBe(201);
  const begun = await apiWrite(admin, 'post', `/api/games/${encodeURIComponent(game.id)}/begin-settlement`);
  expect(begun.status()).toBe(200);
  const draftResponse = await admin.context.get(`/api/games/${encodeURIComponent(game.id)}/settlement-draft`);
  expect(draftResponse.status()).toBe(200);
  const draft = await draftResponse.json() as {
    version: number;
    players: Array<{ playerId: string; nickname: string }>;
  };
  const playerId = (nickname: string) => {
    const found = draft.players.find((player) => player.nickname === nickname)?.playerId;
    expect(found, `settlement player ${nickname}`).toBeTruthy();
    return found!;
  };
  const payload = {
    cashOutByPlayerId: {
      [playerId(accounts.admin.nickname)]: '600',
      [playerId(accounts['player-a'].nickname)]: '1500',
      [playerId(accounts['player-b'].nickname)]: '900'
    },
    roomFee: '380',
    roomPayerIds: [playerId(accounts['player-a'].nickname)],
    otherFee: '0',
    otherFeeNote: '',
    otherPayerIds: [] as string[]
  };
  const saved = await apiWrite(
    admin,
    'put',
    `/api/games/${encodeURIComponent(game.id)}/settlement-draft`,
    { version: draft.version, payload }
  );
  expect(saved.status()).toBe(200);
  const previewResponse = await apiWrite(
    admin,
    'post',
    `/api/games/${encodeURIComponent(game.id)}/settlement-preview`,
    payload
  );
  expect(previewResponse.status()).toBe(200);
  const preview = await previewResponse.json() as {
    draftVersion: number;
    settingsVersion: number;
    confirmationToken: string;
  };
  return {
    game,
    payload,
    preview: {
      draftVersion: preview.draftVersion,
      settingsVersion: preview.settingsVersion,
      confirmationToken: preview.confirmationToken
    }
  };
}

export async function completeBalancedGameApi(
  admin: ApiSession,
  playerA: ApiSession,
  playerB: ApiSession,
  suffix: string,
  onGameCreated?: (gameId: string) => void
) {
  const prepared = await prepareBalancedSettlement(
    admin,
    playerA,
    playerB,
    suffix,
    onGameCreated
  );
  const finalized = await apiWrite(
    admin,
    'post',
    `/api/games/${encodeURIComponent(prepared.game.id)}/settlement-finalize`,
    prepared.preview
  );
  const detail = await finalized.json() as unknown;
  expect(finalized.status(), JSON.stringify(detail)).toBe(201);
  return { ...prepared, detail };
}

export async function closeApiSessions(...sessions: ApiSession[]): Promise<void> {
  await Promise.all(sessions.map(({ context }) => context.dispose()));
}

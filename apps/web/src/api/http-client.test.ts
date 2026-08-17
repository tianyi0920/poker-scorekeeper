import { expect, it } from 'vitest';
import { ApiError } from './http-client.js';

it('replaces an unknown server code and malicious message with local safe feedback', async () => {
  // Break caught: untrusted upstream text is surfaced through the shared API error.
  const error = await ApiError.fromResponse(new Response(JSON.stringify({
    code: 'PROXY_INJECTED', message: '<img src=x onerror=alert(1)> steal this'
  }), { status: 502, headers: { 'Content-Type': 'application/json' } }));

  expect(error.code).toBe('HTTP_ERROR');
  expect(error.message).toBe('请求失败，请稍后重试');
  expect(error.message).not.toContain('steal');
});

it('uses local wording for a known stable API code', async () => {
  // Break caught: stable error wording is delegated back to a server response.
  const error = await ApiError.fromResponse(new Response(JSON.stringify({
    code: 'INVALID_CREDENTIALS', message: 'arbitrary proxy wording'
  }), { status: 401, headers: { 'Content-Type': 'application/json' } }));

  expect(error.code).toBe('INVALID_CREDENTIALS');
  expect(error.message).toBe('用户名或密码错误');
});

it('rejects a toString prototype key as an unknown API code', async () => {
  // Break caught: inherited Object.prototype methods bypass the closed error-code whitelist.
  const error = await ApiError.fromResponse(new Response(JSON.stringify({
    code: 'toString', message: 'untrusted'
  }), { status: 502, headers: { 'Content-Type': 'application/json' } }));

  expect(error.code).toBe('HTTP_ERROR');
  expect(error.message).toBe('请求失败，请稍后重试');
});

it('rejects a constructor prototype key as an unknown API code', async () => {
  // Break caught: inherited constructor access bypasses the closed error-code whitelist.
  const error = await ApiError.fromResponse(new Response(JSON.stringify({
    code: 'constructor', message: 'untrusted'
  }), { status: 502, headers: { 'Content-Type': 'application/json' } }));

  expect(error.code).toBe('HTTP_ERROR');
  expect(error.message).toBe('请求失败，请稍后重试');
});

it('rejects a __proto__ prototype key as an unknown API code', async () => {
  // Break caught: prototype mutation keys bypass the closed error-code whitelist.
  const error = await ApiError.fromResponse(new Response(JSON.stringify({
    code: '__proto__', message: 'untrusted'
  }), { status: 502, headers: { 'Content-Type': 'application/json' } }));

  expect(error.code).toBe('HTTP_ERROR');
  expect(error.message).toBe('请求失败，请稍后重试');
});

it.each([
  ['USERNAME_TAKEN', '用户名已被使用，请换一个'],
  ['NICKNAME_TAKEN', '昵称已被使用，请换一个'],
  ['USER_IN_ACTIVE_GAME', '用户仍在未完成牌局中，请先完成牌局'],
  ['LAST_SUPER_ADMIN', '系统必须保留至少一位启用的超级管理员'],
  ['ACTIVE_GAME_LIMIT', '最多同时开启两场对局，请先完成现有对局'],
  ['ACTIVE_GAME_NAME_TAKEN', '已有进行中对局使用该名称，请更换名称'],
  ['GAME_STATE_CONFLICT', '对局状态已变化，请刷新后重试'],
  ['GAME_PLAYER_LIMIT', '本桌已满 12 人，无法继续加入'],
  ['BUYIN_NOT_LATEST', '购买记录已变化，请刷新后再更正'],
  ['BUYIN_AMOUNT_OVERFLOW', '购买金额超出系统范围，请减少手数'],
  ['BUYIN_IDEMPOTENCY_CONFLICT', '该请求已用于其他购买，请刷新后重试'],
  ['GAME_HAS_BUYINS', '对局已有购买记录，必须完成结算'],
  ['GAME_HAS_RELATIONS', '草稿已关联业务记录，无法删除']
])('maps real backend code %s to actionable local feedback', async (code, message) => {
  // Break caught: frontend aliases drift from the backend and reduce stable errors to a generic failure.
  const error = await ApiError.fromResponse(new Response(JSON.stringify({ code, message: 'server wording' }), {
    status: 409,
    headers: { 'Content-Type': 'application/json' }
  }));

  expect(error.code).toBe(code);
  expect(error.message).toBe(message);
});

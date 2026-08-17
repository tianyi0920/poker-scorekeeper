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

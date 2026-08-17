import { render, screen } from '@testing-library/react';
import { beforeEach, vi } from 'vitest';
import { App } from './App.js';

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    code: 'UNAUTHENTICATED', message: '未登录'
  }), { status: 401, headers: { 'Content-Type': 'application/json' } })));
});

it('renders the product name on the sign-in screen', async () => {
  render(<App />);
  expect(await screen.findByRole('heading', { name: '德州计分' })).toBeInTheDocument();
});

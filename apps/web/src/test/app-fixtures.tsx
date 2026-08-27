import { render } from '@testing-library/react';
import type { ReactElement } from 'react';

export const csrfToken = 'a'.repeat(64);

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function session(role: 'SUPER_ADMIN' | 'ADMIN' | 'USER' = 'USER') {
  return {
    user: {
      id: `${role.toLowerCase()}-1`,
      username: role.toLowerCase(),
      nickname: role === 'SUPER_ADMIN' ? '超级管理员' : role === 'ADMIN' ? '管理员' : '阿明',
      role,
      mustChangePassword: false
    },
    csrfToken
  };
}

export function renderAt(path: string, element: ReactElement): ReturnType<typeof render> {
  window.history.replaceState({}, '', path);
  return render(element);
}

export function currentGame(index: number) {
  return {
    id: `game-${index}`,
    createdById: 'user-creator',
    name: `8月${16 + index}日晚场`,
    status: 'ACTIVE',
    version: 1,
    handPrice: '300',
    rakeEnabled: true,
    startedAt: '2026-08-17T12:00:00.000+08:00',
    stoppedAt: null,
    serverNow: '2026-08-17T13:00:00.000+08:00',
    players: [],
    purchases: [],
    spectators: []
  };
}

export function historyGame(index: number) {
  return {
    id: `history-${index}`,
    name: `第 ${index} 场`,
    startedAt: '2026-08-01T12:00:00.000+08:00',
    completedAt: '2026-08-01T16:00:00.000+08:00',
    durationSeconds: 14_400,
    playerCount: 6,
    myFinalAmount: index % 2 === 0 ? '100' : '-50'
  };
}

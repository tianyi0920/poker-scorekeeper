import type { GameMessageDto } from '@poker/contracts';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { formatMessageRelativeTime, GameMessagesPanel } from './GameMessagesPanel.js';

const createdAt = '2026-08-24T09:00:00.000Z';

it('formats current-game message times as concise Chinese relative time', () => {
  expect(formatMessageRelativeTime(createdAt, Date.parse('2026-08-24T09:00:20.000Z'))).toBe('刚刚');
  expect(formatMessageRelativeTime(createdAt, Date.parse('2026-08-24T09:03:00.000Z'))).toBe('3分钟前');
  expect(formatMessageRelativeTime(createdAt, Date.parse('2026-08-24T11:00:00.000Z'))).toBe('2小时前');
});

it('renders the relative time in the simple message list', () => {
  const message: GameMessageDto = {
    id: '018f5d0d-43a8-7a7a-9b0b-0e8d9de76e01',
    gameId: 'game-1',
    userId: 'user-1',
    nickname: '西西',
    avatarUrl: '/avatars/preset-13.webp',
    text: '马上到',
    createdAt: new Date().toISOString()
  };

  render(<GameMessagesPanel messages={[message]} />);

  expect(screen.getByText('刚刚')).toBeInTheDocument();
});

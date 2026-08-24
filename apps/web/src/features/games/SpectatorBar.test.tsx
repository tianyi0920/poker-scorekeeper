import type { GameMessageDto, GameSpectatorSnapshotDto } from '@poker/contracts';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SpectatorBar } from './SpectatorBar.js';

const spectators: GameSpectatorSnapshotDto[] = [
  { userId: 'watcher-1', nickname: '小王', avatarUrl: '/avatars/preset-12.webp' },
  { userId: 'watcher-2', nickname: '小李', avatarUrl: '/avatars/preset-11.webp' }
];

const latestMessage: GameMessageDto = {
  id: '018f5d0d-43a8-7a7a-9b0b-0e8d9de76e01',
  gameId: 'game-1',
  userId: 'watcher-2',
  nickname: '小李',
  avatarUrl: '/avatars/preset-11.webp',
  text: '我先看看',
  createdAt: '2026-08-24T09:00:00.000Z'
};

it('shows the newest spectator speech only beside its matching avatar', () => {
  // Break caught: spectator speech disappears from the arena or attaches to every observer.
  render(<SpectatorBar spectators={spectators} latestMessage={latestMessage} />);

  expect(screen.getByText('我先看看')).toHaveClass('spectator-speech');
  expect(screen.getByText('我先看看').closest('.spectator')).toHaveTextContent('小李');
});

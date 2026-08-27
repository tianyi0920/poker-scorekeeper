import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { GameSnapshotDto } from '@poker/contracts';
import { currentGame } from '../../test/app-fixtures.js';
import { CurrentGameCard } from './CurrentGameCard.js';

function renderCard(game: GameSnapshotDto) {
  return render(<MemoryRouter><CurrentGameCard game={game} /></MemoryRouter>);
}

it('keeps the whole six-player card navigable without a redundant entry prompt', () => {
  const game = {
    ...currentGame(1),
    status: 'ACTIVE' as const,
    name: '8月25日早场',
    players: Array.from({ length: 6 }, (_, index) => ({
      id: `player-${index + 1}`,
      userId: `user-${index + 1}`,
      nickname: `玩家${index + 1}`,
      avatarUrl: `/avatars/player-${index + 1}.webp`,
      seatNo: index + 1,
      effectiveHands: 1,
      buyInAmount: index === 5 ? '9800' : '500'
    }))
  } satisfies GameSnapshotDto;

  renderCard(game);

  expect(screen.getByRole('link', { name: '进入对局：8月25日早场' }))
    .toHaveAttribute('href', '/games/game-1');
  expect(screen.queryByText(/点击整张卡片进入/)).not.toBeInTheDocument();
  expect(screen.getByText('进行中')).toBeInTheDocument();
  expect(screen.getByText('+1')).toBeInTheDocument();
  expect(screen.getByText('¥12300')).toBeInTheDocument();
  expect(screen.getByText('♠')).toBeInTheDocument();
});

it('keeps the waiting-player label for an empty game', () => {
  renderCard({ ...currentGame(1), status: 'ACTIVE' as const, players: [] } satisfies GameSnapshotDto);

  expect(screen.getByText('等待玩家入座')).toBeInTheDocument();
});

it('keeps the settling status label', () => {
  renderCard({ ...currentGame(1), status: 'SETTLING' as const } satisfies GameSnapshotDto);

  expect(screen.getByText('结算中')).toBeInTheDocument();
});

import type { GameSnapshotDto } from '@poker/contracts';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { RoundTable } from './RoundTable.js';

function makePlayers(count: number): GameSnapshotDto['players'] {
  return Array.from({ length: count }, (_, index) => ({
    id: `player-${index + 1}`,
    userId: index === count - 1 ? 'self' : `user-${index + 1}`,
    nickname: index === count - 1 ? '我' : `牌友${index + 1}`,
    avatarUrl: `/avatars/preset-${String((index % 12) + 1).padStart(2, '0')}.webp`,
    seatNo: index + 1,
    effectiveHands: index + 1,
    buyInAmount: String((index + 1) * 300)
  }));
}

it.each([1, 8, 12])('renders %i unique seats with self anchored at the bottom', (count) => {
  // Break caught: seat rotation overlaps people or moves the current player away from the bottom.
  render(<RoundTable players={makePlayers(count)} selfUserId="self" />);

  const seats = screen.getAllByTestId('table-seat');
  expect(seats).toHaveLength(count);
  expect(screen.getByTestId('seat-self')).toHaveAttribute('data-anchor', 'bottom');
  expect(new Set(seats.map((seat) => seat.getAttribute('data-position'))).size).toBe(count);
});

it('shows the complete financial identity on every compact twelve-player seat', () => {
  // Break caught: the dense layout hides the avatar, nickname, hands, or negative buy-in amount.
  render(<RoundTable players={makePlayers(12)} selfUserId="self" />);

  expect(screen.getByTestId('round-table')).toHaveClass('round-table--compact');
  expect(screen.getByRole('img', { name: '牌友1的头像' })).toBeInTheDocument();
  expect(screen.getByText('牌友1')).toBeInTheDocument();
  expect(screen.getByText('1手')).toBeInTheDocument();
  expect(screen.getByText('-¥300')).toBeInTheDocument();
});

it('keeps the bottom self seat clear of the fixed purchase dock', () => {
  // Break caught: the fixed action dock covers the current player's nickname and money at 360px wide.
  render(<RoundTable players={makePlayers(12)} selfUserId="self" />);

  const selfSeat = screen.getByTestId('seat-self').closest('[data-testid="table-seat"]');
  expect(Number.parseFloat((selfSeat as HTMLElement).style.top)).toBeLessThanOrEqual(80);
});

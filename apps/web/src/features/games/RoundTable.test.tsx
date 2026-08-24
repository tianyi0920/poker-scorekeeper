import type { GameMessageDto, GameSnapshotDto } from '@poker/contracts';
import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { getTableDensity, RoundTable, seatPosition } from './RoundTable.js';

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

const latestMessage: GameMessageDto = {
  id: '018f5d0d-43a8-7a7a-9b0b-0e8d9de76e01',
  gameId: 'game-1',
  userId: 'user-1',
  nickname: '牌友1',
  avatarUrl: '/avatars/preset-01.webp',
  text: '我在路上',
  createdAt: '2026-08-24T09:00:00.000Z'
};

it('renders a portrait poker arena with five community-card slots', () => {
  // Break caught: the table falls back to the short horizontal ellipse or loses its Texas Hold'em identity.
  render(<RoundTable players={makePlayers(2)} selfUserId="self" />);

  expect(screen.getByTestId('round-table')).toHaveClass('round-table--portrait');
  expect(document.querySelectorAll('.community-card-slots i')).toHaveLength(5);
  expect(document.querySelector('.felt-betting-line')).toBeInTheDocument();
});

it('shows only the newest speech beside its matching player seat', () => {
  // Break caught: one message appears on every avatar or beside the wrong player.
  render(<RoundTable players={makePlayers(2)} selfUserId="self" latestMessage={latestMessage} />);

  const senderSeat = screen.getByText('牌友1').closest('[data-testid="table-seat"]');
  const selfSeat = screen.getByTestId('seat-self').closest('[data-testid="table-seat"]');
  expect(senderSeat).not.toBeNull();
  expect(within(senderSeat as HTMLElement).getByText('我在路上')).toHaveClass('seat-speech');
  expect(within(selfSeat as HTMLElement).queryByText('我在路上')).not.toBeInTheDocument();
});

it.each([1, 8, 12])('renders %i unique seats with self anchored at the bottom', (count) => {
  // Break caught: seat rotation overlaps people or moves the current player away from the bottom.
  render(<RoundTable players={makePlayers(count)} selfUserId="self" />);

  const seats = screen.getAllByTestId('table-seat');
  expect(seats).toHaveLength(count);
  expect(screen.getByTestId('seat-self')).toHaveAttribute('data-anchor', 'bottom');
  expect(new Set(seats.map((seat) => seat.getAttribute('data-position'))).size).toBe(count);
});

it.each([
  [0, 'sparse'],
  [1, 'sparse'],
  [2, 'sparse'],
  [3, 'sparse'],
  [4, 'sparse'],
  [5, 'standard'],
  [6, 'standard'],
  [7, 'standard'],
  [8, 'standard'],
  [9, 'full'],
  [10, 'full'],
  [11, 'full'],
  [12, 'full']
] as const)('uses the expected density for %i occupied seats', (count, density) => {
  // Break caught: a sparse table stays at the dense fixed geometry, wasting the first mobile screen.
  expect(getTableDensity(count)).toBe(density);
  render(<RoundTable players={makePlayers(count)} selfUserId="self" />);
  expect(screen.getByTestId('round-table')).toHaveClass(`round-table--${density}`);
});

it('shows the complete financial identity on every compact twelve-player seat', () => {
  // Break caught: the dense layout hides the avatar, nickname, hands, or negative buy-in amount.
  render(<RoundTable players={makePlayers(12)} selfUserId="self" />);

  expect(screen.getByTestId('round-table')).toHaveClass('round-table--compact');
  expect(screen.getByRole('img', { name: '牌友1的头像' })).toBeInTheDocument();
  expect(screen.getByText('牌友1')).toBeInTheDocument();
  expect(screen.getByText('1手')).toBeInTheDocument();
  expect(screen.getByText('−¥300')).toBeInTheDocument();
});

it('keeps the bottom self seat clear of the fixed purchase dock', () => {
  // Break caught: the fixed action dock covers the current player's nickname and money at 360px wide.
  render(<RoundTable players={makePlayers(12)} selfUserId="self" />);

  const selfSeat = screen.getByTestId('seat-self').closest('[data-testid="table-seat"]');
  expect(Number.parseFloat((selfSeat as HTMLElement).style.top)).toBeLessThanOrEqual(80);
});

it('keeps all twelve readable seat rectangles disjoint at a 360px viewport', () => {
  // Break caught: unique center points still let adjacent avatar/nickname/money rectangles visibly overlap.
  const tableWidth = 313;
  const tableHeight = 403;
  const seatWidth = 54;
  const seatHeight = 71;
  const rectangles = Array.from({ length: 12 }, (_, index) => {
    const position = seatPosition(index, 12, 0);
    const centerX = Number.parseFloat(position.left) / 100 * tableWidth;
    const centerY = Number.parseFloat(position.top) / 100 * tableHeight;
    return {
      left: centerX - seatWidth / 2,
      right: centerX + seatWidth / 2,
      top: centerY - seatHeight / 2,
      bottom: centerY + seatHeight / 2
    };
  });
  const overlaps: Array<[number, number]> = [];
  for (let leftIndex = 0; leftIndex < rectangles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rectangles.length; rightIndex += 1) {
      const left = rectangles[leftIndex]!;
      const right = rectangles[rightIndex]!;
      if (left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top) {
        overlaps.push([leftIndex + 1, rightIndex + 1]);
      }
    }
  }

  expect(overlaps).toEqual([]);
});

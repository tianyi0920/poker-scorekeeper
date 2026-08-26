import type { GameSnapshotDto } from '@poker/contracts';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { expect, it } from 'vitest';
import { createHoldemEquityTableState, HoldemEquityTable } from './HoldemEquityTable.js';

function players(): GameSnapshotDto['players'] {
  return [
    {
      id: 'player-first', userId: 'user-first', nickname: '牌友甲', avatarUrl: '/avatars/preset-01.webp',
      seatNo: 1, effectiveHands: 2, buyInAmount: '600'
    },
    {
      id: 'player-self', userId: 'user-self', nickname: '我', avatarUrl: '/avatars/preset-02.webp',
      seatNo: 2, effectiveHands: 3, buyInAmount: '900'
    }
  ];
}

async function chooseCards(triggerName: string, cards: Array<[string, string]>) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: triggerName }));
  for (const [rank, suit] of cards) {
    await user.click(screen.getByRole('button', { name: `选择点数 ${rank}` }));
    await user.click(screen.getByRole('button', { name: `选择花色 ${suit}` }));
  }
  await user.click(screen.getByRole('button', { name: '确认选牌' }));
}

function EquityTableHarness() {
  const [equityState, setEquityState] = useState(createHoldemEquityTableState);
  return (
    <HoldemEquityTable
      players={players()}
      selfUserId="user-self"
      equityState={equityState}
      onEquityStateChange={setEquityState}
    />
  );
}

it('calculates locally from two player hands before and after the flop', async () => {
  // Break caught: selecting cards on the table never produces a two-player equity comparison or switches to exact post-flop odds.
  render(<EquityTableHarness />);

  await chooseCards('为牌友甲选择手牌', [['A', '黑桃'], ['K', '梅花']]);
  await chooseCards('为我选择手牌', [['Q', '红桃'], ['Q', '黑桃']]);

  expect(screen.getByRole('status', { name: '胜率计算状态' }))
    .toHaveTextContent('翻牌前 · 模拟 10,000 次 · 2人');
  expect(screen.getAllByText(/胜率 \d+\.\d%/)).toHaveLength(2);

  await chooseCards('选择翻牌，第1张', [['2', '梅花'], ['7', '方片'], ['9', '红桃']]);

  expect(screen.getByRole('status', { name: '胜率计算状态' }))
    .toHaveTextContent('翻牌 · 精算 990 种 · 2人');
  expect(screen.getByRole('button', { name: '选择转牌' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '选择河牌' })).toBeDisabled();
});

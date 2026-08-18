import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SettlementBreakdown } from './SettlementBreakdown.js';

const breakdown = {
  totals: { buyIn: '18014398509481986000', cashOut: '18014398509481986000', roomFee: '380', otherFee: '20', rake: '131', final: '-531' },
  players: [{ playerId: 'p-1', nickname: '天一', avatarKind: 'PRESET' as const, avatarValue: 'a', seatNo: 1, buyIn: '9007199254740993000', cashOut: '9007199254740994500', rawProfit: '1500', roomFeeShare: '190', otherFeeShare: '10', afterFeeProfit: '1300', rakeEligible: true, rakeAmount: '130', finalAmount: '1170' }]
};

it('renders the three money levels with bigint-safe detail and no write control in history mode', () => {
  // Break caught: history reimplements a rounded settlement calculation or exposes an irreversible write.
  render(<SettlementBreakdown breakdown={breakdown} mode="history" />);
  expect(screen.getByText('牌局盈亏')).toBeInTheDocument();
  expect(screen.getByText('费用后盈亏 · 抽成前应收')).toBeInTheDocument();
  expect(screen.getByText('最终金额 · 最终应收')).toBeInTheDocument();
  expect(screen.getByText((_, element) => element?.textContent === '总买入 ¥18,014,398,509,481,986,000')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /确认并永久锁定结算/ })).not.toBeInTheDocument();
});

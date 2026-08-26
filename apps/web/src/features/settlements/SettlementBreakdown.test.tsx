import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SettlementBreakdown } from './SettlementBreakdown.js';

const breakdown = {
  totals: { buyIn: '18014398509481986000', cashOut: '18014398509481986000', roomFee: '380', otherFee: '20', rake: '131', final: '-531' },
  players: [{ playerId: 'p-1', nickname: 'test', avatarKind: 'PRESET' as const, avatarValue: 'preset-24', seatNo: 1, buyIn: '900', cashOut: '3600', rawProfit: '2700', roomFeeShare: '380', otherFeeShare: '0', afterFeeProfit: '2320', rakeEligible: true, rakeAmount: '232', finalAmount: '2088' }]
};

it('prioritizes winning transfer actions and reveals purchase and accounting detail only on request', () => {
  // Break caught: the bank payment, separate expense, current avatar, hands, or remaining cash are missing or buried in equal-weight cells.
  render(<SettlementBreakdown breakdown={breakdown} mode="history" handPrice="300" />);
  expect(screen.getByRole('img', { name: 'test的当前头像' })).toHaveTextContent('T');
  expect(screen.getByRole('img', { name: 'test的当前头像' }).tagName).toBe('SPAN');
  expect(screen.getByText('本场实际盈利 +¥2,088')).toHaveClass('money--positive');
  expect(screen.getByText('银行付款')).toBeInTheDocument();
  expect(screen.getByText('¥2,320')).toBeInTheDocument();
  expect(screen.getByText('另付经费')).toBeInTheDocument();
  expect(screen.getByText('¥232')).toBeInTheDocument();
  expect(screen.getByText('银行付款 ¥2,320 − 另付经费 ¥232 = 本场实际盈利 ¥2,088')).toBeInTheDocument();
  expect(screen.queryByText('买入手数')).not.toBeInTheDocument();
  expect(screen.queryByText('最终剩余')).not.toBeInTheDocument();

  const toggle = screen.getByRole('button', { name: '展开test的计算明细' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(toggle);
  expect(screen.getByText('买入手数')).toBeInTheDocument();
  expect(screen.getByText('3 手')).toBeInTheDocument();
  expect(screen.getByText('买入金额')).toBeInTheDocument();
  expect(screen.getByText('¥900')).toBeInTheDocument();
  expect(screen.getByText('最终剩余')).toBeInTheDocument();
  expect(screen.getByText('¥3,600')).toBeInTheDocument();
  expect(screen.getAllByText('费用后盈亏 · 抽成前应收')).toHaveLength(2);
  expect(screen.getByText('抽成扣减')).toBeInTheDocument();
  expect(screen.getByText('最终金额 · 最终应收')).toBeInTheDocument();
  expect(screen.getByText((_, element) => element?.textContent === '总买入 ¥18,014,398,509,481,986,000')).toBeInTheDocument();
  expect(screen.getByLabelText('历史结算明细').querySelector('.settlement-breakdown-total')).toHaveTextContent('总抽成 ¥131');
  expect(screen.queryByRole('button', { name: /确认结算/ })).not.toBeInTheDocument();
});

it('shows a losing player only the bank transfer and actual loss with no separate expense', () => {
  // Break caught: a losing player is told to pay a separate expense or sees a negative sign duplicated on the transfer action.
  const losing = { ...breakdown.players[0]!, nickname: '西西', avatarKind: 'UPLOAD' as const, avatarValue: 'latest-avatar.webp', buyIn: '1800', cashOut: '300', rawProfit: '-1500', roomFeeShare: '200', afterFeeProfit: '-1700', rakeEligible: false, rakeAmount: '0', finalAmount: '-1700' };
  render(<SettlementBreakdown breakdown={{ ...breakdown, players: [losing] }} mode="history" handPrice="300" />);

  expect(screen.getByRole('img', { name: '西西的当前头像' })).toHaveAttribute('src', '/avatars/uploads/latest-avatar.webp');
  expect(screen.getByText('本场实际亏损 −¥1,700')).toHaveClass('money--negative');
  expect(screen.getByText('转给银行')).toBeInTheDocument();
  expect(screen.getByText('¥1,700')).toBeInTheDocument();
  expect(screen.getByText('理论转给银行 = 本场实际亏损')).toBeInTheDocument();
  expect(screen.queryByText('另付经费')).not.toBeInTheDocument();
  expect(screen.queryByText('买入手数')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: '展开西西的计算明细' }));
  expect(screen.getByText('6 手')).toBeInTheDocument();
  expect(screen.getByText('¥300')).toBeInTheDocument();
  expect(screen.getByText('费用后盈亏 · 抽成前应付')).toBeInTheDocument();
  expect(screen.getByText('最终金额 · 最终应付')).toBeInTheDocument();
  expect(screen.queryByText('抽成扣减')).not.toBeInTheDocument();
});

it('keeps every player calculation independently collapsed by default', () => {
  // Break caught: one expanded player causes another player's calculation to open or cards start expanded.
  const second = { ...breakdown.players[0]!, playerId: 'p-2', nickname: '西西', seatNo: 2 };
  render(<SettlementBreakdown breakdown={{ ...breakdown, players: [breakdown.players[0]!, second] }} mode="history" handPrice="300" />);
  const toggles = screen.getAllByRole('button', { name: /展开.*的计算明细/ });
  expect(toggles).toHaveLength(2);
  expect(toggles[0]).toHaveAttribute('aria-expanded', 'false');
  expect(toggles[1]).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(toggles[0]!);
  expect(screen.getByRole('button', { name: '收起test的计算明细' })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('button', { name: '展开西西的计算明细' })).toHaveAttribute('aria-expanded', 'false');
});

it('omits the total other-fee entry when its amount is zero', () => {
  // Break caught: the summary presents a nonexistent other fee as ¥0.
  render(<SettlementBreakdown breakdown={{ ...breakdown, totals: { ...breakdown.totals, otherFee: '0' }, players: [{ ...breakdown.players[0]!, otherFeeShare: '0' }] }} mode="history" handPrice="300" />);
  expect(screen.queryByText(/总其他费/)).not.toBeInTheDocument();
});

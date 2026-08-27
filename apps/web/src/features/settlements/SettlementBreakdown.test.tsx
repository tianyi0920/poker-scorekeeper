import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SettlementBreakdown } from './SettlementBreakdown.js';

const breakdown = {
  totals: { buyIn: '18014398509481986000', cashOut: '18014398509481986000', roomFee: '380', otherFee: '20', rake: '131', final: '-531' },
  players: [{ playerId: 'p-1', nickname: 'test', avatarKind: 'PRESET' as const, avatarValue: 'preset-24', seatNo: 1, buyIn: '900', cashOut: '3600', rawProfit: '2700', roomFeeShare: '380', otherFeeShare: '0', afterFeeProfit: '2320', rakeEligible: true, rakeAmount: '232', finalAmount: '2088' }]
};

const losingPlayer = { ...breakdown.players[0]!, playerId: 'p-2', nickname: '西西', avatarKind: 'UPLOAD' as const, avatarValue: 'latest-avatar.webp', seatNo: 2, buyIn: '1800', cashOut: '300', rawProfit: '-1500', roomFeeShare: '200', afterFeeProfit: '-1700', rakeEligible: false, rakeAmount: '0', finalAmount: '-1700' };

it('shows bank receivables, bank payables, and nonzero expenses before personal details', () => {
  // Break caught: players must reconstruct transfers from individual cards, signs are missing, or the transfer summary appears after the details.
  render(<SettlementBreakdown breakdown={{ ...breakdown, players: [breakdown.players[0]!, losingPlayer] }} mode="history" handPrice="300" />);

  const receivable = screen.getByRole('region', { name: '银行应收积分' });
  expect(within(receivable).getByText('需转给银行')).toBeInTheDocument();
  expect(within(receivable).getByText('西西')).toBeInTheDocument();
  expect(within(receivable).getByText('−1,700')).toHaveClass('money--negative');

  const payable = screen.getByRole('region', { name: '银行应付积分' });
  expect(within(payable).getByText('银行需付')).toBeInTheDocument();
  expect(within(payable).getByText('test')).toBeInTheDocument();
  expect(within(payable).getByText('+2,320')).toHaveClass('money--positive');

  const expense = screen.getByRole('region', { name: '经费积分' });
  expect(within(expense).getByText('单独转给固定人员')).toBeInTheDocument();
  expect(within(expense).getByText('test')).toBeInTheDocument();
  expect(within(expense).getByText('232')).toBeInTheDocument();
  expect(screen.queryByText('→')).not.toBeInTheDocument();

  const summary = screen.getByLabelText('结算转账汇总');
  const detailsHeading = screen.getByRole('heading', { name: '个人明细' });
  expect(summary.compareDocumentPosition(detailsHeading) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
});

it('keeps personal history cards compact and reveals nonzero calculation detail only on request', () => {
  // Break caught: the transfer summary is duplicated as oversized actions, or zero-valued rows return to personal details.
  render(<SettlementBreakdown breakdown={breakdown} mode="history" handPrice="300" />);

  const card = screen.getByRole('article', { name: 'test个人明细' });
  expect(screen.getByRole('img', { name: 'test的当前头像' })).toHaveTextContent('T');
  expect(screen.getByRole('img', { name: 'test的当前头像' }).tagName).toBe('SPAN');
  expect(screen.getByText('本场实际盈利 +¥2,088')).toHaveClass('money--positive');
  expect(within(card).getByText('银行应付')).toBeInTheDocument();
  expect(within(card).getByText('+2,320')).toHaveClass('money--positive');
  expect(within(card).getByText('经费')).toBeInTheDocument();
  expect(within(card).getByText('−232')).toHaveClass('rake-value');
  expect(within(card).queryByText('费用扣减')).not.toBeInTheDocument();
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
  expect(screen.getByText('费用后盈亏 · 抽成前应收')).toBeInTheDocument();
  expect(screen.getByText('抽成扣减')).toBeInTheDocument();
  expect(screen.getByText('最终金额 · 最终应收')).toBeInTheDocument();
  expect(screen.getByText((_, element) => element?.textContent === '总买入 ¥18,014,398,509,481,986,000')).toBeInTheDocument();
  expect(screen.getByLabelText('历史结算明细').querySelector('.settlement-breakdown-total')).toHaveTextContent('总抽成 ¥131');
  expect(screen.queryByRole('button', { name: /确认结算/ })).not.toBeInTheDocument();
});

it('shows a losing player only the negative bank receivable and omits the empty expense group', () => {
  // Break caught: a losing player is shown a positive transfer, an expense row, or an empty expense summary card.
  render(<SettlementBreakdown breakdown={{ ...breakdown, players: [losingPlayer] }} mode="history" handPrice="300" />);

  expect(screen.getByRole('img', { name: '西西的当前头像' })).toHaveAttribute('src', '/avatars/uploads/latest-avatar.webp');
  expect(screen.getByText('本场实际亏损 −¥1,700')).toHaveClass('money--negative');
  const card = screen.getByRole('article', { name: '西西个人明细' });
  expect(within(card).getByText('银行应收')).toBeInTheDocument();
  expect(within(card).getByText('−1,700')).toHaveClass('money--negative');
  expect(within(card).queryByText('经费')).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: '经费积分' })).not.toBeInTheDocument();
  expect(screen.queryByText('买入手数')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: '展开西西的计算明细' }));
  expect(screen.getByText('6 手')).toBeInTheDocument();
  expect(screen.getByText('¥300')).toBeInTheDocument();
  expect(screen.getByText('费用后盈亏 · 抽成前应付')).toBeInTheDocument();
  expect(screen.getByText('最终金额 · 最终应付')).toBeInTheDocument();
  expect(screen.queryByText('抽成扣减')).not.toBeInTheDocument();
});

it('keeps a zero-result player visible while omitting every zero-valued personal row', () => {
  // Break caught: zero-value transfer or calculation rows clutter a neutral player's personal detail.
  const neutral = { ...breakdown.players[0]!, nickname: '天一', buyIn: '900', cashOut: '900', rawProfit: '0', roomFeeShare: '0', otherFeeShare: '0', afterFeeProfit: '0', rakeEligible: false, rakeAmount: '0', finalAmount: '0' };
  render(<SettlementBreakdown breakdown={{ ...breakdown, totals: { buyIn: '900', cashOut: '900', roomFee: '0', otherFee: '0', rake: '0', final: '0' }, players: [neutral] }} mode="history" handPrice="300" />);

  const card = screen.getByRole('article', { name: '天一个人明细' });
  expect(within(card).getByText('本场实际收支 ¥0')).toBeInTheDocument();
  expect(within(card).queryByText('银行应收')).not.toBeInTheDocument();
  expect(within(card).queryByText('银行应付')).not.toBeInTheDocument();
  expect(within(card).queryByText('经费')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: '展开天一的计算明细' }));
  expect(screen.getByText('买入手数')).toBeInTheDocument();
  expect(screen.getByText('买入金额')).toBeInTheDocument();
  expect(screen.getByText('最终剩余')).toBeInTheDocument();
  expect(screen.queryByText('牌局盈亏')).not.toBeInTheDocument();
  expect(screen.queryByText('费用扣减')).not.toBeInTheDocument();
  expect(screen.queryByText(/费用后盈亏/)).not.toBeInTheDocument();
  expect(screen.queryByText('抽成扣减')).not.toBeInTheDocument();
  expect(screen.queryByText(/最终金额/)).not.toBeInTheDocument();
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

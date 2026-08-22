import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SettlementBreakdown } from './SettlementBreakdown.js';

const breakdown = {
  totals: { buyIn: '18014398509481986000', cashOut: '18014398509481986000', roomFee: '380', otherFee: '20', rake: '131', final: '-531' },
  players: [{ playerId: 'p-1', nickname: '天一', avatarKind: 'PRESET' as const, avatarValue: 'a', seatNo: 1, buyIn: '9007199254740993000', cashOut: '9007199254740994500', rawProfit: '1500', roomFeeShare: '190', otherFeeShare: '10', afterFeeProfit: '1300', rakeEligible: true, rakeAmount: '130', finalAmount: '1170' }]
};

it('renders the agreed settlement levels with bigint-safe detail and no write control in history mode', () => {
  // Break caught: history exposes an intermediate calculation or an irreversible write.
  render(<SettlementBreakdown breakdown={breakdown} mode="history" />);
  expect(screen.getAllByText('本局输赢')).toHaveLength(1);
  expect(screen.getByText('房费')).toBeInTheDocument();
  expect(screen.getByText('其他费用')).toBeInTheDocument();
  expect(screen.getByText('抽成')).toBeInTheDocument();
  expect(screen.getByText('最终应收')).toBeInTheDocument();
  expect(screen.queryByText(/费用后盈亏/)).not.toBeInTheDocument();
  expect(screen.getByText('+¥1,500')).toBeInTheDocument();
  expect(screen.getByText('¥190')).toBeInTheDocument();
  expect(screen.getByText((_, element) => element?.textContent === '总买入 ¥18,014,398,509,481,986,000')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /确认结算/ })).not.toBeInTheDocument();
});

it('uses a negative raw-profit tone and unsigned final payable amount', () => {
  // Break caught: a losing player is visually labelled as positive or a payable amount has two negative indicators.
  render(<SettlementBreakdown breakdown={{ ...breakdown, players: [{ ...breakdown.players[0]!, rawProfit: '-1500', otherFeeShare: '0', afterFeeProfit: '-1700', finalAmount: '-1800' }] }} mode="history" />);
  const raw = screen.getByText('本局输赢 −¥1,500');
  expect(raw).toHaveClass('money--negative');
  expect(screen.queryByText('其他费用')).not.toBeInTheDocument();
  expect(screen.getByText('最终应付')).toBeInTheDocument();
  expect(screen.getByText('¥1,800').parentElement).toHaveClass('settlement-metric--final');
});

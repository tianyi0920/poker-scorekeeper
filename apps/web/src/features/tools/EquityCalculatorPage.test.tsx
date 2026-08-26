import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { EquityCalculatorPage } from './EquityCalculatorPage.js';

async function chooseCards(triggerName: string, cards: Array<[string, string]>) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: triggerName }));
  for (const [rank, suit] of cards) {
    await user.click(screen.getByRole('button', { name: `选择点数 ${rank}` }));
    await user.click(screen.getByRole('button', { name: `选择花色 ${suit}` }));
  }
  await user.click(screen.getByRole('button', { name: '确认选牌' }));
}

function renderPage() {
  return render(<MemoryRouter><EquityCalculatorPage /></MemoryRouter>);
}

it('starts with two players and enforces flop, turn and river order', () => {
  // Break caught: the standalone tool has the wrong defaults or allows an impossible 1/2-card board.
  renderPage();

  expect(screen.getAllByRole('article', { name: /玩家 \d/ })).toHaveLength(2);
  expect(screen.getByRole('button', { name: '选择翻牌（3张）' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '选择转牌' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '选择河牌' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '计算胜率' })).toBeDisabled();
});

it('supports two to nine players without leaving stale cards behind', async () => {
  // Break caught: the add control exceeds nine players or removal can leave fewer than two participants.
  renderPage();
  const user = userEvent.setup();

  for (let index = 0; index < 7; index += 1) await user.click(screen.getByRole('button', { name: '添加玩家' }));
  expect(screen.getAllByRole('article', { name: /玩家 \d/ })).toHaveLength(9);
  expect(screen.getByRole('button', { name: '添加玩家' })).toBeDisabled();

  for (let index = 0; index < 7; index += 1) await user.click(screen.getAllByRole('button', { name: /移除玩家/ })[0]!);
  expect(screen.getAllByRole('article', { name: /玩家 \d/ })).toHaveLength(2);
  expect(screen.queryByRole('button', { name: /移除玩家/ })).not.toBeInTheDocument();
});

it('calculates preflop equity locally and exposes win and tie percentages', async () => {
  // Break caught: the standalone page is only decorative or omits the existing local evaluator details.
  renderPage();
  await chooseCards('为玩家 1 选择手牌', [['A', '方片'], ['K', '梅花']]);
  await chooseCards('为玩家 2 选择手牌', [['Q', '红桃'], ['Q', '黑桃']]);

  const calculate = screen.getByRole('button', { name: '计算胜率' });
  expect(calculate).toBeEnabled();
  await userEvent.setup().click(calculate);

  const playerOne = screen.getByRole('article', { name: '玩家 1' });
  expect(within(playerOne).getByText('权益')).toBeInTheDocument();
  expect(within(playerOne).getByText(/独赢 .* · 平局 .*/)).toBeInTheDocument();
  expect(screen.getByText(/翻牌前 · 模拟/)).toBeInTheDocument();
});

it('prevents duplicate cards and unlocks later board streets in sequence', async () => {
  // Break caught: a player card can be selected again on the board, or river opens before turn.
  renderPage();
  await chooseCards('为玩家 1 选择手牌', [['A', '黑桃'], ['K', '梅花']]);

  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '选择翻牌（3张）' }));
  await user.click(screen.getByRole('button', { name: '选择点数 A' }));
  expect(screen.getByRole('button', { name: '选择花色 黑桃' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '选择花色 红桃' }));
  await user.click(screen.getByRole('button', { name: '选择点数 K' }));
  await user.click(screen.getByRole('button', { name: '选择花色 黑桃' }));
  await user.click(screen.getByRole('button', { name: '选择点数 Q' }));
  await user.click(screen.getByRole('button', { name: '选择花色 梅花' }));
  await user.click(screen.getByRole('button', { name: '确认选牌' }));

  expect(screen.getByRole('button', { name: '选择转牌' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '选择河牌' })).toBeDisabled();
});

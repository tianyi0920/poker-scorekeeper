import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { HoldemEquityResult } from '../games/holdem-equity.js';
import type { HoldemEquityInput } from '../games/holdem-equity-worker-protocol.js';
import type { HoldemEquityWorkerClient } from '../games/holdem-equity-worker-client.js';
import { EquityCalculatorPage } from './EquityCalculatorPage.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class ControllableClient implements HoldemEquityWorkerClient {
  readonly inputs: HoldemEquityInput[] = [];
  readonly calculations: Array<ReturnType<typeof deferred<HoldemEquityResult>>> = [];
  cancelCalls = 0;

  calculate(input: HoldemEquityInput): Promise<HoldemEquityResult> {
    this.inputs.push(input);
    const calculation = deferred<HoldemEquityResult>();
    this.calculations.push(calculation);
    return calculation.promise;
  }

  cancel(): void {
    this.cancelCalls += 1;
  }

  dispose(): void {}
}

const clients: ControllableClient[] = [];

vi.mock('../games/holdem-equity-worker-client.js', () => ({
  createHoldemEquityWorkerClient: vi.fn(() => {
    const client = new ControllableClient();
    clients.push(client);
    return client;
  })
}));

afterEach(() => {
  clients.length = 0;
});

async function chooseCards(triggerName: string, cards: Array<[string, string]>) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: triggerName }));
  for (const [rank, suit] of cards) {
    await user.click(screen.getByRole('button', { name: `选择点数 ${rank}` }));
    await user.click(screen.getByRole('button', { name: `选择花色 ${suit}` }));
  }
  await user.click(screen.getByRole('button', { name: '确认选牌' }));
}

async function chooseCompleteHands() {
  await chooseCards('为玩家 1 选择手牌', [['A', '方片'], ['K', '梅花']]);
  await chooseCards('为玩家 2 选择手牌', [['Q', '红桃'], ['Q', '黑桃']]);
}

const exactResult: HoldemEquityResult = {
  mode: 'exact',
  samples: 1_712_304,
  players: [
    { id: 'player-1', equityPercentage: 43.2, winPercentage: 42.8, tiePercentage: 0.8 },
    { id: 'player-2', equityPercentage: 56.8, winPercentage: 56.4, tiePercentage: 0.8 }
  ]
};

function renderPage() {
  return render(<MemoryRouter><EquityCalculatorPage /></MemoryRouter>);
}

function client(): ControllableClient {
  expect(clients).toHaveLength(1);
  return clients[0]!;
}

async function calculateToSuccess(result = exactResult) {
  await userEvent.setup().click(screen.getByRole('button', { name: '计算胜率' }));
  await waitFor(() => expect(screen.getByText(/正在精确计算…/)).toBeInTheDocument());
  client().calculations.at(-1)!.resolve(result);
  await waitFor(() => expect(screen.getByText(/精确穷举 · 共计算/)).toBeInTheDocument());
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

it('keeps complete card selections unsubmitted until the manual calculate button is clicked', async () => {
  // Break caught: changing a card starts an expensive exact enumeration before the user submits it.
  renderPage();
  await chooseCompleteHands();

  expect(screen.getByRole('button', { name: '计算胜率' })).toBeEnabled();
  expect(screen.getByText('翻牌前 · 选完所有玩家手牌后计算')).toBeInTheDocument();
  expect(screen.queryByText('正在精确计算…')).not.toBeInTheDocument();
  expect(screen.queryByText('权益')).not.toBeInTheDocument();
});

it('shows loading and disables duplicate manual submission while exact calculation is active', async () => {
  // Break caught: repeated clicks can queue multiple Worker calculations for the same selected cards.
  renderPage();
  await chooseCompleteHands();

  await userEvent.setup().click(screen.getByRole('button', { name: '计算胜率' }));

  await waitFor(() => expect(screen.getByText(/正在精确计算…/)).toBeInTheDocument());
  expect(screen.getByRole('button', { name: '计算胜率' })).toBeDisabled();
  expect(client().inputs).toHaveLength(1);
});

it('renders exact sample count and every player equity, win and tie result after success', async () => {
  // Break caught: the standalone result hides exact enumeration provenance or any per-player outcome value.
  renderPage();
  await chooseCompleteHands();
  await calculateToSuccess();

  expect(screen.getByText('翻牌前 · 精确穷举 · 共计算 1,712,304 种牌面 · 2人')).toBeInTheDocument();
  const playerOne = screen.getByRole('article', { name: '玩家 1' });
  const playerTwo = screen.getByRole('article', { name: '玩家 2' });
  expect(within(playerOne).getByText('43.2%')).toBeInTheDocument();
  expect(within(playerOne).getByText('独赢 42.8% · 平局 0.8%')).toBeInTheDocument();
  expect(within(playerTwo).getByText('56.8%')).toBeInTheDocument();
  expect(within(playerTwo).getByText('独赢 56.4% · 平局 0.8%')).toBeInTheDocument();
  expect(screen.getByText('仅在本机计算，不上传牌面')).toBeInTheDocument();
});

it('invalidates a submitted result when a player hand or board is changed', async () => {
  // Break caught: displayed equity remains associated with cards that are no longer on the table.
  renderPage();
  await chooseCompleteHands();
  await calculateToSuccess();
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: '为玩家 1 选择手牌' }));
  await user.click(screen.getByRole('button', { name: '移除 A方片' }));
  await user.click(screen.getByRole('button', { name: '选择点数 A' }));
  await user.click(screen.getByRole('button', { name: '选择花色 黑桃' }));
  await user.click(screen.getByRole('button', { name: '确认选牌' }));

  await waitFor(() => expect(screen.getByText('翻牌前 · 选完所有玩家手牌后计算')).toBeInTheDocument());
  expect(screen.queryByText('43.2%')).not.toBeInTheDocument();

  await calculateToSuccess();

  await chooseCards('选择翻牌（3张）', [['2', '梅花'], ['7', '方片'], ['9', '红桃']]);

  await waitFor(() => expect(screen.getByText('翻牌 · 选完所有玩家手牌后计算')).toBeInTheDocument());
  expect(screen.queryByText('43.2%')).not.toBeInTheDocument();
  expect(client().cancelCalls).toBeGreaterThan(0);
});

it('invalidates a submitted result when players are added, removed, or a picker group is cleared', async () => {
  // Break caught: structural edits or clearing selected cards leave outcomes for a different player set visible.
  renderPage();
  await chooseCompleteHands();
  await calculateToSuccess();
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: '添加玩家' }));
  await waitFor(() => expect(screen.queryByText('43.2%')).not.toBeInTheDocument());
  expect(screen.getAllByRole('article', { name: /玩家 \d/ })).toHaveLength(3);

  await chooseCards('为玩家 3 选择手牌', [['J', '方片'], ['T', '梅花']]);
  await calculateToSuccess();
  await user.click(screen.getByRole('button', { name: '移除玩家 3' }));
  await waitFor(() => expect(screen.queryByText('43.2%')).not.toBeInTheDocument());

  await calculateToSuccess();
  await user.click(screen.getByRole('button', { name: '为玩家 1 选择手牌' }));
  await user.click(screen.getByRole('button', { name: '清空本组' }));

  await waitFor(() => expect(screen.getByText('翻牌前 · 选完所有玩家手牌后计算')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: '计算胜率' })).toBeDisabled();
});

it('keeps selected cards and shows the generic message when exact calculation fails', async () => {
  // Break caught: an error loses the editable card selection or exposes Worker details.
  renderPage();
  await chooseCompleteHands();

  await userEvent.setup().click(screen.getByRole('button', { name: '计算胜率' }));
  await waitFor(() => expect(screen.getByText(/正在精确计算…/)).toBeInTheDocument());
  client().calculations[0]!.reject(new Error('internal evaluator details'));

  await waitFor(() => expect(screen.getByText('翻牌前 · 精确计算失败，请重试')).toBeInTheDocument());
  expect(screen.queryByText('43.2%')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '计算胜率' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '为玩家 1 选择手牌' })).toHaveTextContent('A♦K♣');
});

it('cancels current work and returns to an empty two-player state when reset', async () => {
  // Break caught: clearing the calculator leaves a Worker running or retains players/cards from the prior hand.
  renderPage();
  await chooseCompleteHands();
  await userEvent.setup().click(screen.getByRole('button', { name: '计算胜率' }));
  await waitFor(() => expect(screen.getByText(/正在精确计算…/)).toBeInTheDocument());

  await userEvent.setup().click(screen.getByRole('button', { name: '清空' }));

  await waitFor(() => expect(screen.getByText('翻牌前 · 选完所有玩家手牌后计算')).toBeInTheDocument());
  expect(client().cancelCalls).toBeGreaterThan(0);
  expect(screen.getAllByRole('article', { name: /玩家 \d/ })).toHaveLength(2);
  expect(screen.getByRole('button', { name: '计算胜率' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '为玩家 1 选择手牌' })).toHaveTextContent('++');
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

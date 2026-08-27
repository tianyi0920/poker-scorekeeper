import type { GameSnapshotDto } from '@poker/contracts';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { HoldemEquityResult } from './holdem-equity.js';
import type { HoldemEquityState } from './useHoldemEquity.js';

const mockedUseHoldemEquity = vi.hoisted(() => vi.fn());

vi.mock('./useHoldemEquity.js', () => ({
  useHoldemEquity: mockedUseHoldemEquity
}));

import { createHoldemEquityTableState, HoldemEquityTable, type HoldemEquityTableState } from './HoldemEquityTable.js';

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

function tablePlayers(count: number): GameSnapshotDto['players'] {
  return Array.from({ length: count }, (_, index) => ({
    id: `player-${index + 1}`,
    userId: `user-${index + 1}`,
    nickname: `牌友${index + 1}`,
    avatarUrl: `/avatars/preset-${String(index + 1).padStart(2, '0')}.webp`,
    seatNo: index + 1,
    effectiveHands: 1,
    buyInAmount: '300'
  }));
}

const completeState: HoldemEquityTableState = {
  boardCards: [undefined, undefined, undefined, undefined, undefined],
  playerCards: {
    'player-first': ['As', 'Kc'],
    'player-self': ['Qh', 'Qs']
  }
};

const firstResult: HoldemEquityResult = {
  mode: 'exact',
  samples: 1_712_304,
  players: [
    { id: 'player-first', equityPercentage: 81.3, winPercentage: 81.1, tiePercentage: 0.4 },
    { id: 'player-self', equityPercentage: 18.7, winPercentage: 18.6, tiePercentage: 0.4 }
  ]
};

const latestResult: HoldemEquityResult = {
  mode: 'exact',
  samples: 1_712_304,
  players: [
    { id: 'player-first', equityPercentage: 54.2, winPercentage: 53.9, tiePercentage: 0.6 },
    { id: 'player-self', equityPercentage: 45.8, winPercentage: 45.5, tiePercentage: 0.6 }
  ]
};

const nineHandsState: HoldemEquityTableState = {
  boardCards: [undefined, undefined, undefined, undefined, undefined],
  playerCards: {
    'player-1': ['As', 'Ah'],
    'player-2': ['Ks', 'Kh'],
    'player-3': ['Qs', 'Qh'],
    'player-4': ['Js', 'Jh'],
    'player-5': ['Ts', 'Th'],
    'player-6': ['9s', '9h'],
    'player-7': ['8s', '8h'],
    'player-8': ['7s', '7h'],
    'player-9': ['6s', '6h']
  }
};

const tenHandsState: HoldemEquityTableState = {
  ...nineHandsState,
  playerCards: { ...nineHandsState.playerCards, 'player-10': ['5s', '5h'] }
};

let hookState: HoldemEquityState;
let fakeCalculationCount: number;
let previousSubmittedInput: unknown;

beforeEach(() => {
  hookState = { status: 'idle', result: null };
  fakeCalculationCount = 0;
  previousSubmittedInput = undefined;
  mockedUseHoldemEquity.mockReset();
  mockedUseHoldemEquity.mockImplementation((input: unknown) => (
    input === null
      ? { status: 'idle', result: null }
      : (() => {
        if (input !== previousSubmittedInput) fakeCalculationCount += 1;
        previousSubmittedInput = input;
        return hookState;
      })()
  ));
});

function EquityTableHarness({
  initialState = createHoldemEquityTableState(),
  playerSnapshot = players()
}: {
  initialState?: HoldemEquityTableState;
  playerSnapshot?: GameSnapshotDto['players'];
}) {
  const [equityState, setEquityState] = useState(initialState);
  return (
    <HoldemEquityTable
      players={playerSnapshot}
      selfUserId="user-self"
      equityState={equityState}
      onEquityStateChange={setEquityState}
    />
  );
}

it('keeps the card-selection instruction while fewer than two hands are complete', () => {
  // Break caught: an incomplete table starts a Worker calculation or presents a result without enough hands.
  render(<EquityTableHarness />);

  expect(screen.getByRole('status', { name: '胜率计算状态' }))
    .toHaveTextContent('翻牌前 · 选择至少2名玩家手牌');
  expect(screen.queryByText(/胜率 \d+\.\d%/)).not.toBeInTheDocument();
});

it('immediately replaces old percentages with the exact-calculation loading state', () => {
  // Break caught: render-time enumeration blocks the table and keeps an old or synchronous percentage visible.
  hookState = { status: 'loading', result: null };
  render(<EquityTableHarness initialState={completeState} />);

  expect(screen.getByRole('status', { name: '胜率计算状态' }))
    .toHaveTextContent('翻牌前 · 正在精确计算…');
  expect(screen.queryByText(/胜率 \d+\.\d%/)).not.toBeInTheDocument();
});

it('renders exact percentages and the exhaustive-board count only after success', () => {
  // Break caught: a completed Worker response is presented as a simulation or omits its exhaustive sample count.
  hookState = { status: 'success', result: firstResult };
  render(<EquityTableHarness initialState={completeState} />);

  expect(screen.getByRole('status', { name: '胜率计算状态' }))
    .toHaveTextContent('翻牌前 · 精确穷举 · 共计算 1,712,304 种牌面 · 2人');
  expect(screen.getByText('胜率 81.3%')).toBeInTheDocument();
  expect(screen.getByText('胜率 18.7%')).toBeInTheDocument();
});

it('keeps a successful calculation when an equivalent player snapshot rerenders', () => {
  // Break caught: a same-content realtime snapshot recreates the submitted input, cancels the Worker, and clears success values.
  hookState = { status: 'success', result: firstResult };
  const rendered = render(<EquityTableHarness initialState={completeState} playerSnapshot={players()} />);

  expect(fakeCalculationCount).toBe(1);
  expect(screen.getByText('胜率 81.3%')).toBeInTheDocument();

  rendered.rerender(<EquityTableHarness initialState={completeState} playerSnapshot={players()} />);

  expect(fakeCalculationCount).toBe(1);
  expect(screen.getByText('胜率 81.3%')).toBeInTheDocument();
  expect(screen.queryByText('正在精确计算…')).not.toBeInTheDocument();
});

it('drops the previous result during a rapid card change and accepts only the current result', async () => {
  // Break caught: a previous request's percentage remains visible while a changed hand is awaiting its own result.
  const user = userEvent.setup();
  hookState = { status: 'success', result: firstResult };
  const rendered = render(<EquityTableHarness initialState={completeState} />);

  expect(screen.getByText('胜率 81.3%')).toBeInTheDocument();
  hookState = { status: 'loading', result: null };
  await user.click(screen.getByRole('button', { name: /为牌友甲.*手牌/ }));
  await user.click(screen.getByRole('button', { name: '移除 A黑桃' }));
  await user.click(screen.getByRole('button', { name: '选择点数 J' }));
  await user.click(screen.getByRole('button', { name: '选择花色 红桃' }));
  await user.click(screen.getByRole('button', { name: '确认选牌' }));

  expect(screen.getByRole('status', { name: '胜率计算状态' })).toHaveTextContent('正在精确计算…');
  expect(screen.queryByText('胜率 81.3%')).not.toBeInTheDocument();

  hookState = { status: 'success', result: latestResult };
  rendered.rerender(<EquityTableHarness initialState={completeState} />);

  expect(screen.getByText('胜率 54.2%')).toBeInTheDocument();
  expect(screen.queryByText('胜率 81.3%')).not.toBeInTheDocument();
});

it('keeps selected cards but clears percentages when exact calculation fails', () => {
  // Break caught: a Worker failure discards the selected deal or leaves the previous success values on screen.
  hookState = { status: 'error', result: null };
  render(<EquityTableHarness initialState={completeState} />);

  expect(screen.getByRole('status', { name: '胜率计算状态' }))
    .toHaveTextContent('翻牌前 · 精确计算失败，请重试');
  expect(screen.getByRole('button', { name: /为牌友甲.*手牌/ })).toHaveTextContent('A♠K♣');
  expect(screen.queryByText(/胜率 \d+\.\d%/)).not.toBeInTheDocument();
});

it('starts a new calculation after changing cards and returns to idle after clearing a hand', async () => {
  // Break caught: editing a complete hand retains a stale result, or clearing it leaves a Worker calculation active.
  const user = userEvent.setup();
  hookState = { status: 'loading', result: null };
  render(<EquityTableHarness initialState={completeState} />);

  await user.click(screen.getByRole('button', { name: /为牌友甲.*手牌/ }));
  await user.click(screen.getByRole('button', { name: '移除 A黑桃' }));
  await user.click(screen.getByRole('button', { name: '选择点数 J' }));
  await user.click(screen.getByRole('button', { name: '选择花色 红桃' }));
  await user.click(screen.getByRole('button', { name: '确认选牌' }));

  expect(screen.getByRole('status', { name: '胜率计算状态' })).toHaveTextContent('正在精确计算…');

  await user.click(screen.getByRole('button', { name: /为牌友甲.*手牌/ }));
  await user.click(screen.getByRole('button', { name: '清空本组' }));

  expect(screen.getByRole('status', { name: '胜率计算状态' }))
    .toHaveTextContent('翻牌前 · 选择至少2名玩家手牌');
  expect(screen.queryByText(/胜率 \d+\.\d%/)).not.toBeInTheDocument();
});

it('does not submit a preloaded tenth complete hand to the Worker', () => {
  // Break caught: externally restored ten-hand state reaches the nine-player equity kernel and becomes a generic calculation error.
  hookState = { status: 'loading', result: null };
  render(<EquityTableHarness initialState={tenHandsState} playerSnapshot={tablePlayers(10)} />);

  expect(fakeCalculationCount).toBe(0);
  expect(screen.getByRole('status', { name: '胜率计算状态' }))
    .toHaveTextContent('最多选择9名玩家参与胜率计算');
});

it('blocks the tenth player until one of nine selected hands is cleared', async () => {
  // Break caught: the tenth player can open a confirmable picker and writes an unsupported ten-player deal.
  const user = userEvent.setup();
  hookState = { status: 'loading', result: null };
  render(<EquityTableHarness initialState={nineHandsState} playerSnapshot={tablePlayers(10)} />);

  expect(fakeCalculationCount).toBe(1);
  await user.click(screen.getByRole('button', { name: '为牌友10选择手牌' }));

  expect(screen.queryByRole('heading', { name: '选择牌友10的手牌' })).not.toBeInTheDocument();
  expect(screen.getByRole('status', { name: '胜率计算状态' }))
    .toHaveTextContent('最多选择9名玩家参与胜率计算');
  expect(fakeCalculationCount).toBe(1);

  await user.click(screen.getByRole('button', { name: /为牌友1修改手牌/ }));
  await user.click(screen.getByRole('button', { name: '清空本组' }));
  await user.click(screen.getByRole('button', { name: '为牌友10选择手牌' }));

  expect(screen.getByRole('heading', { name: '选择牌友10的手牌' })).toBeInTheDocument();
});

import { describe, expect, it } from 'vitest';
import { calculateHoldemEquity, type HoldemCard } from './holdem-equity.js';

describe('calculateHoldemEquity', () => {
  it('reports a deterministic winner when all five community cards are known', () => {
    // Break caught: a stronger completed Texas Hold'em hand is ranked below a weaker hand.
    const result = calculateHoldemEquity({
      players: [
        { id: 'aces', cards: ['As', 'Ad'] },
        { id: 'kings', cards: ['Kh', 'Kd'] }
      ],
      boardCards: ['2c', '7d', '9h', 'Jc', '3s']
    });

    expect(result).toEqual({
      mode: 'exact',
      samples: 1,
      players: [
        { id: 'aces', equityPercentage: 100, winPercentage: 100, tiePercentage: 0 },
        { id: 'kings', equityPercentage: 0, winPercentage: 0, tiePercentage: 0 }
      ]
    });
  });

  it('splits equity evenly when the board itself is the winning hand', () => {
    // Break caught: tied pots are counted as full wins or assigned to only one player.
    const result = calculateHoldemEquity({
      players: [
        { id: 'first', cards: ['2c', '3d'] },
        { id: 'second', cards: ['4c', '5d'] }
      ],
      boardCards: ['As', 'Ks', 'Qs', 'Js', 'Ts']
    });

    expect(result.players).toEqual([
      { id: 'first', equityPercentage: 50, winPercentage: 0, tiePercentage: 100 },
      { id: 'second', equityPercentage: 50, winPercentage: 0, tiePercentage: 100 }
    ]);
  });

  it('keeps a losing player at zero when rounded equity is reconciled to 100 percent', () => {
    // Break caught: the rounding remainder is assigned to the final player even when that hand has no equity.
    const result = calculateHoldemEquity({
      players: [
        { id: 'tie-one', cards: ['Qc', 'Jc'] },
        { id: 'tie-two', cards: ['Qd', 'Jd'] },
        { id: 'tie-three', cards: ['Qh', 'Jh'] },
        { id: 'loser', cards: ['6s', '5s'] }
      ],
      boardCards: ['As', 'Kd', '7c', '3h', '2h']
    });

    expect(result.players.find(({ id }) => id === 'loser')?.equityPercentage).toBe(0);
    expect(result.players.reduce((total, player) => total + player.equityPercentage, 0)).toBeCloseTo(100, 5);
  });

  it('enumerates every legal five-card board before the flop', () => {
    // Break caught: pre-flop calculation falls back to a bounded simulation instead of exact enumeration.
    const result = calculateHoldemEquity({
      players: [
        { id: 'aces', cards: ['As', 'Ah'] },
        { id: 'kings', cards: ['Kc', 'Kd'] }
      ],
      boardCards: []
    });

    expect(result.mode).toBe('exact');
    expect(result.samples).toBe(1_712_304);
    expect(result.players.reduce((total, player) => total + player.equityPercentage, 0)).toBeCloseTo(100, 5);
  });

  it.each([
    {
      name: 'a two-card community board',
      boardCards: ['2c', '7d'],
      error: '公共牌只能是 0、3、4 或 5 张'
    },
    {
      name: 'a duplicated visible card',
      boardCards: ['As', '7d', '9h'],
      error: '牌面中不能出现重复的牌'
    }
  ] satisfies Array<{ name: string; boardCards: HoldemCard[]; error: string }>)('rejects $name before invoking the evaluator', ({ boardCards, error }) => {
    // Break caught: an impossible or incomplete visible deal reaches the odds engine and produces misleading output.
    expect(() => calculateHoldemEquity({
      players: [
        { id: 'first', cards: ['As', 'Ad'] },
        { id: 'second', cards: ['Kh', 'Kd'] }
      ],
      boardCards
    })).toThrow(error);
  });
});

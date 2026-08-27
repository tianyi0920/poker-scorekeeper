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
    expect(result.players).toEqual([
      { id: 'aces', equityPercentage: 81.3, winPercentage: 81.1, tiePercentage: 0.4 },
      { id: 'kings', equityPercentage: 18.7, winPercentage: 18.6, tiePercentage: 0.4 }
    ]);
    expect(result.players.reduce((total, player) => total + player.equityPercentage, 0)).toBeCloseTo(100, 5);
  });

  it('enumerates every legal two-card runout on the flop', () => {
    // Break caught: a flop calculation returns simulated results or an incorrect number of legal runouts.
    const result = calculateHoldemEquity({
      players: [
        { id: 'aces', cards: ['As', 'Ah'] },
        { id: 'kings', cards: ['Kc', 'Kd'] }
      ],
      boardCards: ['2c', '7d', '9h']
    });

    expect(result).toEqual({
      mode: 'exact',
      samples: 990,
      players: [
        { id: 'aces', equityPercentage: 91.6, winPercentage: 91.6, tiePercentage: 0 },
        { id: 'kings', equityPercentage: 8.4, winPercentage: 8.4, tiePercentage: 0 }
      ]
    });
  });

  it('enumerates every legal one-card runout on the turn', () => {
    // Break caught: a turn calculation returns simulated results or an incorrect number of legal runouts.
    const result = calculateHoldemEquity({
      players: [
        { id: 'aces', cards: ['As', 'Ah'] },
        { id: 'kings', cards: ['Kc', 'Kd'] }
      ],
      boardCards: ['2c', '7d', '9h', 'Jc']
    });

    expect(result).toEqual({
      mode: 'exact',
      samples: 44,
      players: [
        { id: 'aces', equityPercentage: 95.5, winPercentage: 95.5, tiePercentage: 0 },
        { id: 'kings', equityPercentage: 4.5, winPercentage: 4.5, tiePercentage: 0 }
      ]
    });
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

  it('rejects more than nine complete players before invoking the evaluator', () => {
    // Break caught: unsupported ten-player deals reach the evaluator despite the public game limit.
    expect(() => calculateHoldemEquity({
      players: [
        { id: 'one', cards: ['As', 'Ah'] },
        { id: 'two', cards: ['Ks', 'Kh'] },
        { id: 'three', cards: ['Qs', 'Qh'] },
        { id: 'four', cards: ['Js', 'Jh'] },
        { id: 'five', cards: ['Ts', 'Th'] },
        { id: 'six', cards: ['9s', '9h'] },
        { id: 'seven', cards: ['8s', '8h'] },
        { id: 'eight', cards: ['7s', '7h'] },
        { id: 'nine', cards: ['6s', '6h'] },
        { id: 'ten', cards: ['5s', '5h'] }
      ],
      boardCards: ['2c', '3d', '4h']
    })).toThrow('最多只能有九名玩家');
  });

  it('rejects malformed cards at runtime before invoking the evaluator', () => {
    // Break caught: untyped external inputs bypass the TypeScript card union and reach the odds engine.
    expect(() => calculateHoldemEquity({
      players: [
        { id: 'first', cards: ['As', 'Ah'] },
        { id: 'second', cards: ['Kc', 'Kd'] }
      ],
      boardCards: ['2c', '7d', '1x' as HoldemCard]
    })).toThrow('牌面中包含无效的牌');
  });
});

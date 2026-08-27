import { equityHoldem } from '@poker-apprentice/hand-evaluator';

export type HoldemCard = `${'2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A'}${'c' | 'd' | 'h' | 's'}`;

export interface HoldemEquityPlayer {
  id: string;
  cards: HoldemCard[];
}

export interface HoldemEquityResult {
  mode: 'exact';
  samples: number;
  players: Array<{
    id: string;
    equityPercentage: number;
    winPercentage: number;
    tiePercentage: number;
  }>;
}

const allowedBoardCounts = new Set([0, 3, 4, 5]);
const holdemCardPattern = /^[2-9TJQKA][cdhs]$/;
const suitSymbols = { c: '♣', d: '♦', h: '♥', s: '♠' } as const;
const suitNames = { c: '梅花', d: '方片', h: '红桃', s: '黑桃' } as const;

export function holdemCardText(card: HoldemCard): string {
  return `${card[0] === 'T' ? '10' : card[0]}${suitSymbols[card[1] as keyof typeof suitSymbols]}`;
}

export function holdemCardName(card: HoldemCard): string {
  return `${card[0] === 'T' ? '10' : card[0]}${suitNames[card[1] as keyof typeof suitNames]}`;
}

export function holdemCardTone(card: HoldemCard): 'red' | 'black' {
  return card[1] === 'd' || card[1] === 'h' ? 'red' : 'black';
}

function percentage(value: number): number {
  return Number((value * 100).toFixed(1));
}

export function calculateHoldemEquity({
  players,
  boardCards
}: {
  players: HoldemEquityPlayer[];
  boardCards: HoldemCard[];
}): HoldemEquityResult {
  if (players.length < 2) throw new Error('至少需要两名已选择手牌的玩家');
  if (players.length > 9) throw new Error('最多只能有九名玩家');
  if (players.some(({ cards }) => cards.length !== 2)) throw new Error('每名玩家必须选择两张手牌');
  if (!allowedBoardCounts.has(boardCards.length)) throw new Error('公共牌只能是 0、3、4 或 5 张');

  const visibleCards = [...boardCards, ...players.flatMap(({ cards }) => cards)];
  if (visibleCards.some((card) => !holdemCardPattern.test(card))) throw new Error('牌面中包含无效的牌');
  if (new Set(visibleCards).size !== visibleCards.length) throw new Error('牌面中不能出现重复的牌');

  const evaluatorHands = players.map(({ cards }) => cards) as Parameters<typeof equityHoldem>[0];
  const evaluatorBoard = boardCards as Parameters<typeof equityHoldem>[1];
  const evaluated = equityHoldem(evaluatorHands, evaluatorBoard);

  const calculatedPlayers = players.map(({ id }, index) => {
    const player = evaluated[index]!;
    return {
      id,
      equityPercentage: percentage(player.equity),
      winPercentage: percentage(player.wins / player.total),
      tiePercentage: percentage(player.ties / player.total)
    };
  });
  const displayedTotal = calculatedPlayers.reduce((total, player) => total + player.equityPercentage, 0);
  const reconciliationPlayer = calculatedPlayers.reduce((highest, player) => (
    player.equityPercentage > highest.equityPercentage ? player : highest
  ));
  reconciliationPlayer.equityPercentage = Number((
    reconciliationPlayer.equityPercentage + 100 - displayedTotal
  ).toFixed(1));

  return {
    mode: 'exact',
    samples: evaluated[0]?.total ?? 0,
    players: calculatedPlayers
  };
}

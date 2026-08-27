import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { HoldemCardPicker } from './HoldemCardPicker.js';
import type { HoldemCard } from './holdem-equity.js';
import { RoundTable, type BoardSelectionTarget } from './RoundTable.js';
import { useHoldemEquity } from './useHoldemEquity.js';

type RoundTableProps = Omit<Parameters<typeof RoundTable>[0], 'equityControls'>;
type PickerTarget = { type: 'board'; target: BoardSelectionTarget } | { type: 'player'; playerId: string };

export interface HoldemEquityTableState {
  boardCards: Array<HoldemCard | undefined>;
  playerCards: Record<string, HoldemCard[]>;
}

export function createHoldemEquityTableState(): HoldemEquityTableState {
  return {
    boardCards: [undefined, undefined, undefined, undefined, undefined],
    playerCards: {}
  };
}

const sampleFormatter = new Intl.NumberFormat('zh-CN');
const validBoardCounts = new Set([0, 3, 4, 5]);
const maximumEquityParticipants = 9;
const participantLimitMessage = '最多选择9名玩家参与胜率计算';

function playerSelectionSignature(
  players: RoundTableProps['players'],
  playerCards: HoldemEquityTableState['playerCards']
): string {
  return players.map(({ id }) => {
    const cards = playerCards[id];
    const selectedCards = cards?.length === 2 ? cards : [];
    return `${id.length}:${id}:${selectedCards.join(',')}`;
  }).join('|');
}

function boardSelectionSignature(boardCards: HoldemEquityTableState['boardCards']): string {
  return boardCards.map((card) => card ?? '').join(',');
}

export function HoldemEquityTable({
  equityState,
  onEquityStateChange,
  ...props
}: RoundTableProps & {
  equityState: HoldemEquityTableState;
  onEquityStateChange: Dispatch<SetStateAction<HoldemEquityTableState>>;
}) {
  const { boardCards, playerCards } = equityState;
  const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null);
  const [selectionLimitReached, setSelectionLimitReached] = useState(false);
  const playersSignature = playerSelectionSignature(props.players, playerCards);
  const participants = useMemo(() => props.players.flatMap((player) => {
    const cards = playerCards[player.id];
    return cards?.length === 2 ? [{ id: player.id, cards }] : [];
  }), [playersSignature]);
  const boardSignature = boardSelectionSignature(boardCards);
  const visibleBoard = useMemo(
    () => boardCards.filter((card): card is HoldemCard => card !== undefined),
    [boardSignature]
  );
  const submittedInput = useMemo(() => {
    if (
      participants.length < 2
      || participants.length > maximumEquityParticipants
      || !validBoardCounts.has(visibleBoard.length)
    ) return null;
    return { players: participants, boardCards: visibleBoard };
  }, [participants, visibleBoard]);
  const submission = useMemo(() => submittedInput === null ? null : {
    input: submittedInput,
    requestId: 0
  }, [submittedInput]);
  const calculation = useHoldemEquity(submission);
  const percentages = calculation.status === 'success'
    ? Object.fromEntries(calculation.result.players.map(({ id, equityPercentage }) => [id, equityPercentage]))
    : {};
  const street = visibleBoard.length === 0 ? '翻牌前' : visibleBoard.length === 3 ? '翻牌' : visibleBoard.length === 4 ? '转牌' : '河牌';
  const summary = participants.length > maximumEquityParticipants || selectionLimitReached
    ? `${street} · ${participantLimitMessage}`
    : calculation.status === 'idle'
    ? `${street} · 选择至少2名玩家手牌`
    : calculation.status === 'loading'
      ? `${street} · 正在精确计算…`
      : calculation.status === 'error'
        ? `${street} · 精确计算失败，请重试`
        : `${street} · 精确穷举 · 共计算 ${sampleFormatter.format(calculation.result.samples)} 种牌面 · ${participants.length}人`;
  const disabledBoardTargets: BoardSelectionTarget[] = [
    ...(visibleBoard.length < 3 ? ['turn', 'river'] as const : []),
    ...(visibleBoard.length < 4 ? ['river'] as const : [])
  ];

  const currentPlayerIds = new Set(props.players.map(({ id }) => id));
  const allVisibleCards = [
    ...visibleBoard,
    ...Object.entries(playerCards).flatMap(([playerId, cards]) => currentPlayerIds.has(playerId) ? cards : [])
  ];
  const picker = pickerTarget === null ? undefined : (() => {
    if (pickerTarget.type === 'player') {
      const player = props.players.find(({ id }) => id === pickerTarget.playerId);
      return {
        title: `选择${player?.nickname ?? '玩家'}的手牌`,
        initialCards: playerCards[pickerTarget.playerId] ?? [],
        requiredCount: 2
      };
    }
    if (pickerTarget.target === 'flop') return { title: '选择翻牌（3张）', initialCards: visibleBoard.slice(0, 3), requiredCount: 3 };
    if (pickerTarget.target === 'turn') return { title: '选择转牌', initialCards: boardCards[3] === undefined ? [] : [boardCards[3]], requiredCount: 1 };
    return { title: '选择河牌', initialCards: boardCards[4] === undefined ? [] : [boardCards[4]], requiredCount: 1 };
  })();
  const excludedCards = picker === undefined
    ? []
    : allVisibleCards.filter((card) => !picker.initialCards.includes(card));

  const clearPickerTarget = () => {
    if (pickerTarget?.type === 'player') {
      onEquityStateChange((current) => {
        const next = { ...current.playerCards };
        delete next[pickerTarget.playerId];
        return { ...current, playerCards: next };
      });
    } else if (pickerTarget?.target === 'flop') {
      onEquityStateChange((current) => ({ ...current, boardCards: [undefined, undefined, undefined, undefined, undefined] }));
    } else if (pickerTarget?.target === 'turn') {
      onEquityStateChange((current) => ({
        ...current,
        boardCards: [current.boardCards[0], current.boardCards[1], current.boardCards[2], undefined, undefined]
      }));
    } else if (pickerTarget?.target === 'river') {
      onEquityStateChange((current) => ({
        ...current,
        boardCards: [current.boardCards[0], current.boardCards[1], current.boardCards[2], current.boardCards[3], undefined]
      }));
    }
    setSelectionLimitReached(false);
    setPickerTarget(null);
  };

  const confirmPickerTarget = (cards: HoldemCard[]) => {
    if (pickerTarget?.type === 'player') {
      onEquityStateChange((current) => ({
        ...current,
        playerCards: { ...current.playerCards, [pickerTarget.playerId]: cards }
      }));
    } else if (pickerTarget?.target === 'flop') {
      onEquityStateChange((current) => ({
        ...current,
        boardCards: [cards[0], cards[1], cards[2], current.boardCards[3], current.boardCards[4]]
      }));
    } else if (pickerTarget?.target === 'turn') {
      onEquityStateChange((current) => ({
        ...current,
        boardCards: [current.boardCards[0], current.boardCards[1], current.boardCards[2], cards[0], current.boardCards[4]]
      }));
    } else if (pickerTarget?.target === 'river') {
      onEquityStateChange((current) => ({
        ...current,
        boardCards: [current.boardCards[0], current.boardCards[1], current.boardCards[2], current.boardCards[3], cards[0]]
      }));
    }
    setSelectionLimitReached(false);
    setPickerTarget(null);
  };

  return (
    <>
      <RoundTable
        {...props}
        equityControls={{
          boardCards,
          playerCards,
          percentages,
          summary,
          disabledBoardTargets,
          onSelectBoard: (target) => {
            if (!disabledBoardTargets.includes(target)) setPickerTarget({ type: 'board', target });
          },
          onSelectPlayer: (playerId) => {
            if (playerCards[playerId]?.length !== 2 && participants.length >= maximumEquityParticipants) {
              setSelectionLimitReached(true);
              return;
            }
            setSelectionLimitReached(false);
            setPickerTarget({ type: 'player', playerId });
          }
        }}
      />
      {picker !== undefined && (
        <HoldemCardPicker
          key={`${pickerTarget?.type}:${pickerTarget?.type === 'player' ? pickerTarget.playerId : pickerTarget?.target}`}
          title={picker.title}
          initialCards={picker.initialCards}
          requiredCount={picker.requiredCount}
          excludedCards={excludedCards}
          onClose={() => setPickerTarget(null)}
          onClear={clearPickerTarget}
          onConfirm={confirmPickerTarget}
        />
      )}
    </>
  );
}

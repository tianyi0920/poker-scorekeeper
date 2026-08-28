import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { HoldemCardPicker } from '../games/HoldemCardPicker.js';
import {
  holdemCardText,
  holdemCardTone,
  type HoldemCard
} from '../games/holdem-equity.js';
import { useHoldemEquity, type HoldemEquitySubmission } from '../games/useHoldemEquity.js';

type Player = { id: string };
type PickerTarget = { type: 'player'; playerId: string } | { type: 'board'; street: 'flop' | 'turn' | 'river' };

const emptyBoard = (): Array<HoldemCard | undefined> => [undefined, undefined, undefined, undefined, undefined];
const initialPlayers = (): Player[] => [{ id: 'player-1' }, { id: 'player-2' }];
const sampleFormatter = new Intl.NumberFormat('zh-CN');

function CardFace({ card }: { card: HoldemCard | undefined }) {
  return <span className={card === undefined ? 'equity-tool-card equity-tool-card--empty' : `equity-tool-card equity-tool-card--${holdemCardTone(card)}`}>
    {card === undefined ? '+' : holdemCardText(card)}
  </span>;
}

export function EquityCalculatorPage() {
  const nextPlayerId = useRef(3);
  const nextRequestId = useRef(1);
  const [players, setPlayers] = useState<Player[]>(initialPlayers);
  const [boardCards, setBoardCards] = useState<Array<HoldemCard | undefined>>(emptyBoard);
  const [playerCards, setPlayerCards] = useState<Record<string, HoldemCard[]>>({});
  const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null);
  const [submission, setSubmission] = useState<HoldemEquitySubmission | null>(null);
  const visibleBoard = boardCards.filter((card): card is HoldemCard => card !== undefined);
  const completePlayers = players.flatMap((player) => {
    const cards = playerCards[player.id];
    return cards?.length === 2 ? [{ id: player.id, cards }] : [];
  });
  const calculation = useHoldemEquity(submission);
  const canCalculate = completePlayers.length === players.length && players.length >= 2 && calculation.status !== 'loading';
  const result = calculation.status === 'success' ? calculation.result : null;
  const resultByPlayer = useMemo(() => new Map(result?.players.map((entry) => [entry.id, entry]) ?? []), [result]);

  const invalidate = () => setSubmission(null);
  const reset = () => {
    nextPlayerId.current = 3;
    setPlayers(initialPlayers());
    setBoardCards(emptyBoard());
    setPlayerCards({});
    setPickerTarget(null);
    setSubmission(null);
  };
  const addPlayer = () => {
    if (players.length >= 9) return;
    setPlayers((current) => [...current, { id: `player-${nextPlayerId.current++}` }]);
    invalidate();
  };
  const removePlayer = (playerId: string) => {
    if (players.length <= 2) return;
    setPlayers((current) => current.filter(({ id }) => id !== playerId));
    setPlayerCards((current) => {
      const next = { ...current };
      delete next[playerId];
      return next;
    });
    invalidate();
  };

  const playerName = (playerId: string) => `玩家 ${players.findIndex(({ id }) => id === playerId) + 1}`;
  const allVisibleCards = [...visibleBoard, ...players.flatMap(({ id }) => playerCards[id] ?? [])];
  const picker = pickerTarget === null ? null : (() => {
    if (pickerTarget.type === 'player') return {
      title: `选择${playerName(pickerTarget.playerId)}的手牌`,
      initialCards: playerCards[pickerTarget.playerId] ?? [],
      requiredCount: 2
    };
    if (pickerTarget.street === 'flop') return { title: '选择翻牌（3张）', initialCards: visibleBoard.slice(0, 3), requiredCount: 3 };
    if (pickerTarget.street === 'turn') return { title: '选择转牌', initialCards: boardCards[3] === undefined ? [] : [boardCards[3]], requiredCount: 1 };
    return { title: '选择河牌', initialCards: boardCards[4] === undefined ? [] : [boardCards[4]], requiredCount: 1 };
  })();
  const excludedCards = picker === null ? [] : allVisibleCards.filter((card) => !picker.initialCards.includes(card));

  const clearPickerTarget = () => {
    if (pickerTarget?.type === 'player') {
      setPlayerCards((current) => {
        const next = { ...current };
        delete next[pickerTarget.playerId];
        return next;
      });
    } else if (pickerTarget?.street === 'flop') {
      setBoardCards(emptyBoard());
    } else if (pickerTarget?.street === 'turn') {
      setBoardCards((current) => [current[0], current[1], current[2], undefined, undefined]);
    } else if (pickerTarget?.street === 'river') {
      setBoardCards((current) => [current[0], current[1], current[2], current[3], undefined]);
    }
    invalidate();
    setPickerTarget(null);
  };
  const confirmPickerTarget = (cards: HoldemCard[]) => {
    if (pickerTarget?.type === 'player') {
      setPlayerCards((current) => ({ ...current, [pickerTarget.playerId]: cards }));
    } else if (pickerTarget?.street === 'flop') {
      setBoardCards((current) => [cards[0], cards[1], cards[2], current[3], current[4]]);
    } else if (pickerTarget?.street === 'turn') {
      setBoardCards((current) => [current[0], current[1], current[2], cards[0], current[4]]);
    } else if (pickerTarget?.street === 'river') {
      setBoardCards((current) => [current[0], current[1], current[2], current[3], cards[0]]);
    }
    invalidate();
    setPickerTarget(null);
  };
  const calculate = () => {
    if (!canCalculate) return;
    setSubmission({
      input: {
        players: completePlayers.map(({ id, cards }) => ({ id, cards: [...cards] })),
        boardCards: [...visibleBoard]
      },
      requestId: nextRequestId.current++
    });
  };
  const street = visibleBoard.length === 0 ? '翻牌前' : visibleBoard.length === 3 ? '翻牌' : visibleBoard.length === 4 ? '转牌' : '河牌';

  return <section className="page-stack equity-tool-page" aria-labelledby="equity-tool-title">
    <header className="equity-tool-heading">
      <Link to="/profile" aria-label="返回我的"><span aria-hidden="true">←</span> 返回我的</Link>
      <h1 id="equity-tool-title">胜率计算器</h1>
      <button type="button" onClick={reset}>清空</button>
    </header>

    <section className="card equity-board-panel" aria-labelledby="equity-board-title">
      <div className="equity-tool-section-heading"><div><h3 id="equity-board-title">公共牌</h3><span>按翻牌、转牌、河牌顺序选择</span></div><strong>{street}</strong></div>
      <div className="equity-board-streets">
        <button type="button" className="equity-board-street equity-board-street--flop" aria-label="选择翻牌（3张）" onClick={() => setPickerTarget({ type: 'board', street: 'flop' })}>
          <span>翻牌</span><span className="equity-board-cards"><CardFace card={boardCards[0]} /><CardFace card={boardCards[1]} /><CardFace card={boardCards[2]} /></span>
        </button>
        <button type="button" className="equity-board-street" aria-label="选择转牌" disabled={visibleBoard.length < 3} onClick={() => setPickerTarget({ type: 'board', street: 'turn' })}>
          <span>转牌</span><CardFace card={boardCards[3]} />
        </button>
        <button type="button" className="equity-board-street" aria-label="选择河牌" disabled={visibleBoard.length < 4} onClick={() => setPickerTarget({ type: 'board', street: 'river' })}>
          <span>河牌</span><CardFace card={boardCards[4]} />
        </button>
      </div>
    </section>

    <section className="card equity-players-panel" aria-labelledby="equity-players-title">
      <div className="equity-tool-section-heading">
        <div><h3 id="equity-players-title">玩家手牌</h3><span>默认 2 人，最多 9 人</span></div>
        <button type="button" className="equity-player-add" aria-label="添加玩家" disabled={players.length >= 9} onClick={addPlayer}>＋</button>
      </div>
      <div className="equity-tool-players">
        {players.map((player, index) => {
          const name = `玩家 ${index + 1}`;
          const cards = playerCards[player.id] ?? [];
          const playerResult = resultByPlayer.get(player.id);
          return <article className="equity-tool-player" aria-label={name} key={player.id}>
            <div className="equity-tool-player-main">
              <span className="equity-player-number">P{index + 1}</span>
              <strong>{name}</strong>
              {players.length > 2 && <button type="button" aria-label={`移除${name}`} onClick={() => removePlayer(player.id)}>×</button>}
            </div>
            <button type="button" className="equity-player-cards" aria-label={`为${name} 选择手牌`} onClick={() => setPickerTarget({ type: 'player', playerId: player.id })}>
              <CardFace card={cards[0]} /><CardFace card={cards[1]} />
            </button>
            <div className="equity-player-result" aria-live="polite">
              {playerResult === undefined ? <span>选择两张手牌</span> : <>
                <span>权益</span><strong>{playerResult.equityPercentage.toFixed(1)}%</strong>
                <small>独赢 {playerResult.winPercentage.toFixed(1)}% · 平局 {playerResult.tiePercentage.toFixed(1)}%</small>
              </>}
            </div>
          </article>;
        })}
      </div>
    </section>

    <button type="button" className="button button--primary equity-calculate" disabled={!canCalculate} onClick={calculate}>计算胜率</button>
    <footer className="equity-tool-footer">
      <p className="equity-tool-summary">{calculation.status === 'idle'
        ? `${street} · 选完所有玩家手牌后计算`
        : calculation.status === 'loading'
          ? `${street} · 正在精确计算…`
          : calculation.status === 'error'
            ? `${street} · 精确计算失败，请重试`
            : `${street} · 精确穷举 · 共计算 ${sampleFormatter.format(calculation.result.samples)} 种牌面 · ${players.length}人`}</p>
      <p className="equity-tool-local-note">仅在本机计算，不上传牌面</p>
    </footer>

    {picker !== null && <HoldemCardPicker
      key={`${pickerTarget?.type}:${pickerTarget?.type === 'player' ? pickerTarget.playerId : pickerTarget?.street}`}
      title={picker.title}
      initialCards={picker.initialCards}
      requiredCount={picker.requiredCount}
      excludedCards={excludedCards}
      onClose={() => setPickerTarget(null)}
      onClear={clearPickerTarget}
      onConfirm={confirmPickerTarget}
    />}
  </section>;
}

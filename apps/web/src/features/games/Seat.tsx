import type { GameMessageDto, GameSnapshotDto } from '@poker/contracts';
import type { CSSProperties } from 'react';
import { formatSignedMoney, formatUnsignedMoney } from '../../components/money-format.js';
import { holdemCardName, holdemCardText, holdemCardTone, type HoldemCard } from './holdem-equity.js';

export function Seat({
  player,
  position,
  positionKey,
  self,
  compact,
  speechDirection,
  latestMessage,
  equityCards,
  equityPercentage,
  onSelectEquityCards
}: {
  player: GameSnapshotDto['players'][number];
  position: { left: string; top: string };
  positionKey: string;
  self: boolean;
  compact: boolean;
  speechDirection: 'left' | 'right';
  latestMessage?: GameMessageDto;
  equityCards?: HoldemCard[];
  equityPercentage?: number;
  onSelectEquityCards?: () => void;
}) {
  const amount = -BigInt(player.buyInAmount);
  const formattedAmount = formatSignedMoney(amount.toString());
  const ariaAmount = formatUnsignedMoney(player.buyInAmount).slice(1);
  return (
    <article
      className={`table-seat${self ? ' table-seat--self' : ''}${compact ? ' table-seat--compact' : ''} table-seat--speech-${speechDirection}`}
      style={position as CSSProperties}
      data-testid="table-seat"
      data-position={positionKey}
      data-anchor={self ? 'bottom' : undefined}
      aria-label={`${player.nickname}，${player.effectiveHands}手，买入负${ariaAmount}元`}
    >
      {self && <span className="visually-hidden" data-testid="seat-self" data-anchor="bottom">我的座位</span>}
      <img src={player.avatarUrl} alt={`${player.nickname}的头像`} />
      <strong title={player.nickname}>{player.nickname}</strong>
      <span className="seat-finance"><span>{player.effectiveHands}手</span><b>{formattedAmount}</b></span>
      {onSelectEquityCards !== undefined && (
        <>
          <button
            type="button"
            className="seat-hole-cards"
            aria-label={equityCards?.length === 2
              ? `为${self ? '我' : player.nickname}修改手牌，${equityCards.map(holdemCardName).join(' ')}`
              : `为${self ? '我' : player.nickname}选择手牌`}
            onClick={onSelectEquityCards}
          >
            {Array.from({ length: 2 }, (_, index) => {
              const card = equityCards?.[index];
              return <span className={card === undefined ? 'seat-hole-card seat-hole-card--empty' : `seat-hole-card seat-hole-card--${holdemCardTone(card)}`} key={index}>{card === undefined ? '+' : holdemCardText(card)}</span>;
            })}
          </button>
          <span className="seat-equity">{equityPercentage === undefined ? '点此选牌' : `胜率 ${equityPercentage.toFixed(1)}%`}</span>
        </>
      )}
      {latestMessage && <span className="seat-speech seat-speech--corner">{latestMessage.text}</span>}
    </article>
  );
}

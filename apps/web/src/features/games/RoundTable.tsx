import type { GameMessageDto, GameSnapshotDto } from '@poker/contracts';
import type { ReactNode } from 'react';
import { formatUnsignedMoney } from '../../components/money-format.js';
import { Seat } from './Seat.js';

const compactSeatPositions = [
  [50, 80], [29, 81], [12, 63], [9, 45], [12, 27], [29, 9],
  [50, 9], [71, 9], [88, 27], [91, 45], [88, 63], [71, 81]
] as const;

export function getTableDensity(occupiedSeatCount: number): 'sparse' | 'standard' | 'full' {
  if (occupiedSeatCount <= 4) return 'sparse';
  if (occupiedSeatCount <= 8) return 'standard';
  return 'full';
}

export function seatPosition(index: number, count: number, selfIndex: number) {
  const anchorIndex = selfIndex >= 0 ? selfIndex : 0;
  const rotated = (index - anchorIndex + count) % count;
  if (count >= 9) {
    const slot = Math.round((rotated * compactSeatPositions.length) / count) % compactSeatPositions.length;
    const [left, top] = compactSeatPositions[slot]!;
    return {
      left: `${left}%`,
      top: `${top}%`,
      key: `${left.toFixed(4)}:${top.toFixed(4)}`
    };
  }
  const angle = Math.PI / 2 + (rotated * Math.PI * 2) / count;
  const left = 50 + Math.cos(angle) * 40;
  const top = 50 + Math.sin(angle) * 30;
  return {
    left: `${left}%`,
    top: `${top}%`,
    key: `${left.toFixed(4)}:${top.toFixed(4)}`
  };
}

export function RoundTable({
  players,
  selfUserId,
  latestMessage,
  purchases = [],
  handPrice = '0',
  children
}: {
  players: GameSnapshotDto['players'];
  selfUserId: string;
  latestMessage?: GameMessageDto;
  purchases?: GameSnapshotDto['purchases'];
  handPrice?: string;
  children?: ReactNode;
}) {
  const ordered = [...players].sort((left, right) => left.seatNo - right.seatNo);
  const selfIndex = ordered.findIndex(({ userId }) => userId === selfUserId);
  const compact = ordered.length >= 9;
  const density = getTableDensity(ordered.length);
  const latestPurchase = [...purchases].sort((left, right) => (
    Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id)
  ))[0];
  const latestBuyer = latestPurchase === undefined
    ? undefined
    : ordered.find(({ id }) => id === latestPurchase.playerId);
  const purchaseAmount = latestPurchase === undefined
    ? 0n
    : BigInt(handPrice) * BigInt(latestPurchase.handsDelta);
  const purchaseDescription = latestPurchase?.type === 'ADJUST'
    ? `更正为 ${latestPurchase.newHands} 手`
    : latestPurchase === undefined
      ? ''
      : `购买 ${Math.abs(latestPurchase.handsDelta)} 手`;

  return (
    <section
      className={`round-table round-table--portrait round-table--${density}${compact ? ' round-table--compact' : ''}`}
      data-testid="round-table"
      aria-label={`牌桌，${ordered.length} 名玩家`}
    >
      <div className="poker-felt" aria-hidden="true">
        <span className="felt-betting-line" />
        <span className="felt-center-line felt-center-line--vertical" />
        <span className="felt-center-line felt-center-line--horizontal" />
        <span className="community-card-slots">
          {Array.from({ length: 5 }, (_, index) => (
            <i className="community-card community-card--back" key={index}>
              <span className="community-card__mark">♠</span>
            </i>
          ))}
        </span>
      </div>
      <div className="table-center">
        {latestPurchase !== undefined && latestBuyer !== undefined ? (
          <div
            className="table-latest-purchase"
            key={latestPurchase.id}
            role="status"
            aria-label="最新购买记录"
            aria-live="polite"
          >
            <span>最新购买</span>
            <strong title={latestBuyer.nickname}>{latestBuyer.nickname}</strong>
            <p><em>{purchaseDescription}</em><b>{formatUnsignedMoney(purchaseAmount.toString())}</b></p>
          </div>
        ) : ordered.length === 0 ? <strong className="table-waiting">等待玩家入座</strong> : children}
      </div>
      {ordered.map((player, index) => {
        const position = seatPosition(index, ordered.length, selfIndex);
        const left = Number.parseFloat(position.left);
        const speechDirection = left >= 65 ? 'left' : 'right';
        return (
          <Seat
            key={player.id}
            player={player}
            position={{ left: position.left, top: position.top }}
            positionKey={position.key}
            self={player.userId === selfUserId}
            compact={compact}
            speechDirection={speechDirection}
            latestMessage={latestMessage?.userId === player.userId ? latestMessage : undefined}
          />
        );
      })}
    </section>
  );
}

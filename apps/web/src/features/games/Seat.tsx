import type { GameSnapshotDto } from '@poker/contracts';
import type { CSSProperties } from 'react';

const integerFormatter = new Intl.NumberFormat('zh-CN');

export function Seat({
  player,
  position,
  positionKey,
  self,
  compact
}: {
  player: GameSnapshotDto['players'][number];
  position: { left: string; top: string };
  positionKey: string;
  self: boolean;
  compact: boolean;
}) {
  const amount = integerFormatter.format(BigInt(player.buyInAmount));
  return (
    <article
      className={`table-seat${self ? ' table-seat--self' : ''}${compact ? ' table-seat--compact' : ''}`}
      style={position as CSSProperties}
      data-testid="table-seat"
      data-position={positionKey}
      data-anchor={self ? 'bottom' : undefined}
      aria-label={`${player.nickname}，${player.effectiveHands}手，买入负${amount}元`}
    >
      {self && <span className="visually-hidden" data-testid="seat-self" data-anchor="bottom">我的座位</span>}
      <img src={player.avatarUrl} alt={`${player.nickname}的头像`} />
      <strong title={player.nickname}>{player.nickname}</strong>
      <span>{player.effectiveHands}手</span>
      <b>-¥{amount}</b>
    </article>
  );
}

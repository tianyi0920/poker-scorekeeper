import type { GameSnapshotDto } from '@poker/contracts';
import type { ReactNode } from 'react';
import { Seat } from './Seat.js';

const compactSeatPositions = [
  [50, 80], [29, 81], [12, 63], [9, 45], [12, 27], [29, 9],
  [50, 9], [71, 9], [88, 27], [91, 45], [88, 63], [71, 81]
] as const;

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
  children
}: {
  players: GameSnapshotDto['players'];
  selfUserId: string;
  children?: ReactNode;
}) {
  const ordered = [...players].sort((left, right) => left.seatNo - right.seatNo);
  const selfIndex = ordered.findIndex(({ userId }) => userId === selfUserId);
  const compact = ordered.length >= 9;

  return (
    <section
      className={`round-table${compact ? ' round-table--compact' : ''}`}
      data-testid="round-table"
      aria-label={`牌桌，共 ${ordered.length} 位玩家`}
    >
      <div className="poker-felt" aria-hidden="true"><span className="felt-line" /></div>
      <div className="table-center">{children}</div>
      {ordered.map((player, index) => {
        const position = seatPosition(index, ordered.length, selfIndex);
        return (
          <Seat
            key={player.id}
            player={player}
            position={{ left: position.left, top: position.top }}
            positionKey={position.key}
            self={player.userId === selfUserId}
            compact={compact}
          />
        );
      })}
    </section>
  );
}

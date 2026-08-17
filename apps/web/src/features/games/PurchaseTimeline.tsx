import type { GameSnapshotDto } from '@poker/contracts';
import { Button } from '../../components/Button.js';

const integerFormatter = new Intl.NumberFormat('zh-CN');

export function PurchaseTimeline({
  purchases,
  players,
  selfUserId,
  handPrice,
  canAdjust,
  onAdjust
}: {
  purchases: GameSnapshotDto['purchases'];
  players: GameSnapshotDto['players'];
  selfUserId: string;
  handPrice: string;
  canAdjust: boolean;
  onAdjust: (playerId: string, currentHands: number) => void;
}) {
  const playerById = new Map(players.map((player) => [player.id, player]));
  const selfPlayerId = players.find(({ userId }) => userId === selfUserId)?.id;
  const ordered = [...purchases].sort((left, right) => (
    Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id)
  ));
  const latestSelfEventId = ordered.find(({ playerId }) => playerId === selfPlayerId)?.id;

  if (ordered.length === 0) {
    return <div className="timeline-empty"><span aria-hidden="true">♢</span><p>还没有购买记录</p></div>;
  }

  return (
    <ol className="purchase-timeline" aria-label="购买时间线">
      {ordered.map((purchase) => {
        const player = playerById.get(purchase.playerId);
        const amount = BigInt(handPrice) * BigInt(purchase.handsDelta);
        const financialAmount = -amount;
        const isLatestSelf = purchase.id === latestSelfEventId;
        return (
          <li key={purchase.id} data-testid="purchase-event">
            <span className={`timeline-dot timeline-dot--${purchase.type.toLowerCase()}`} aria-hidden="true" />
            <div className="timeline-card">
              <div className="timeline-title">
                <strong>{player?.nickname ?? '未知玩家'}</strong>
                <time dateTime={purchase.createdAt}>{new Date(purchase.createdAt).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
              </div>
              <p>{purchase.type === 'BUY'
                ? `购买 ${purchase.newHands} 手`
                : `更正 ${purchase.previousHands ?? 0} → ${purchase.newHands} 手`}</p>
              <div className="timeline-meta">
                <span>操作：{purchase.actorNickname}</span>
                <b className={financialAmount > 0n ? 'money--positive' : 'money--negative'}>
                  {financialAmount > 0n ? '+' : financialAmount < 0n ? '-' : ''}¥{integerFormatter.format(financialAmount < 0n ? -financialAmount : financialAmount)}
                </b>
              </div>
              {canAdjust && isLatestSelf && selfPlayerId !== undefined && (
                <Button variant="ghost" unsafe onClick={() => onAdjust(selfPlayerId, purchase.newHands)}>
                  更正我的最后一笔购买
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

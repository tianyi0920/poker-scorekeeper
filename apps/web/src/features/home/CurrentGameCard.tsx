import type { GameSnapshotDto } from '@poker/contracts';
import { Link } from 'react-router-dom';
import { Card } from '../../components/Card.js';

export function CurrentGameCard({ game }: { game: GameSnapshotDto }) {
  const totalBuyIn = game.players.reduce((sum, player) => sum + BigInt(player.buyInAmount), 0n);
  return <Card className="current-game-card">
    <div className="card-heading"><div><span className="live-pill">{game.status === 'SETTLING' ? '结算中' : '进行中'}</span><h3>{game.name}</h3></div><span className="table-orbit" aria-hidden="true">♠</span></div>
    <dl className="stat-grid">
      <div><dt>每手</dt><dd>¥{game.handPrice}</dd></div>
      <div><dt>玩家</dt><dd>{game.players.length} / 12</dd></div>
      <div><dt>总买入</dt><dd>¥{totalBuyIn.toString()}</dd></div>
    </dl>
    <Link className="action-link" to={`/games/${encodeURIComponent(game.id)}`}>进入对局 <span aria-hidden="true">→</span></Link>
  </Card>;
}

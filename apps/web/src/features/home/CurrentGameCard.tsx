import type { GameSnapshotDto } from '@poker/contracts';
import { Link } from 'react-router-dom';
import { UserAvatar } from '../../components/UserAvatar.js';

export function CurrentGameCard({ game }: { game: GameSnapshotDto }) {
  const totalBuyIn = game.players.reduce((sum, player) => sum + BigInt(player.buyInAmount), 0n);
  const visiblePlayers = game.players.slice(0, 5);

  return <Link
    className="card current-game-card"
    to={`/games/${encodeURIComponent(game.id)}`}
    aria-label={`进入对局：${game.name}`}
  >
    <div className="card-heading"><div><span className="live-pill">{game.status === 'SETTLING' ? '结算中' : '进行中'}</span><h3>{game.name}</h3></div><span className="table-orbit" aria-hidden="true">♠</span></div>
    <div className="current-game-players">
      {visiblePlayers.length > 0 ? <>
        <span className="current-game-avatar-stack">
          {visiblePlayers.map((player) => <UserAvatar key={player.id} className="current-game-avatar" nickname={player.nickname} avatarUrl={player.avatarUrl} />)}
          {game.players.length > visiblePlayers.length && <span className="current-game-avatar-more">+{game.players.length - visiblePlayers.length}</span>}
        </span>
        <span className="current-game-player-names">
          {visiblePlayers.map((player) => player.nickname).join('、')}
        </span>
      </> : <span className="current-game-player-names">等待玩家入座</span>}
    </div>
    <dl className="stat-grid">
      <div><dt>每手</dt><dd>¥{game.handPrice}</dd></div>
      <div><dt>玩家</dt><dd>{game.players.length} / 12</dd></div>
      <div><dt>总买入</dt><dd>¥{totalBuyIn.toString()}</dd></div>
    </dl>
    <span className="current-game-enter">点击整张卡片进入 <span aria-hidden="true">→</span></span>
  </Link>;
}

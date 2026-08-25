import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { GameSnapshotDto } from '@poker/contracts';
import { scorekeeperApi } from '../../api/resources.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { Card } from '../../components/Card.js';
import { Toast } from '../../components/Toast.js';
import { CurrentGameCard } from './CurrentGameCard.js';
import { GAME_DELETED_NOTICE } from '../games/useGameDeletedSubscription.js';

const MAX_OPEN_GAMES = 5;

function readDeletedGameNotice(state: unknown): string | null {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return null;
  const record = state as Record<string, unknown>;
  return Object.keys(record).length === 1 && record.notice === GAME_DELETED_NOTICE
    ? GAME_DELETED_NOTICE
    : null;
}

export function HomePage() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [notice] = useState(() => readDeletedGameNotice(location.state));
  const [current, setCurrent] = useState<GameSnapshotDto[]>([]);
  const [currentLoading, setCurrentLoading] = useState(true);
  const [currentError, setCurrentError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void scorekeeperApi.currentGames()
      .then((response) => { if (active) setCurrent(Array.isArray(response.games) ? response.games.slice(0, MAX_OPEN_GAMES) : []); })
      .catch(() => { if (active) setCurrentError('当前对局暂时无法加载，请稍后重试'); })
      .finally(() => { if (active) setCurrentLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (readDeletedGameNotice(location.state) !== null) {
      navigate('.', { replace: true, state: null });
    }
  }, [location.state, navigate]);

  const canManageGames = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';
  const capacityReached = current.length >= MAX_OPEN_GAMES;

  return <div className="page-stack home-page" aria-label="主页基础框架">
    {notice !== null && <p className="toast toast--info" role="status" aria-label="对局删除提示">{notice}</p>}
    <section aria-labelledby="current-games-title">
      <div className="section-heading">
        <div><span className="section-kicker">实时牌桌</span><h2 id="current-games-title">当前对局</h2></div>
        <div className="current-game-section-actions">
          {!currentLoading && currentError === null && <span className="current-game-capacity">当前 {current.length} / {MAX_OPEN_GAMES} 场</span>}
          {canManageGames && (capacityReached
            ? <span className="compact-link compact-link--disabled" aria-disabled="true">已达 {MAX_OPEN_GAMES} 场上限</span>
            : <Link className="compact-link" to="/games/new">创建对局</Link>)}
        </div>
      </div>
      {currentError !== null ? <Toast tone="error" message={currentError} /> : currentLoading ? <p className="muted">正在加载对局…</p> : current.length === 0
        ? <Card className="empty-card"><span aria-hidden="true">◇</span><p>当前没有进行中的对局</p>{canManageGames && <Link className="action-link" to="/games/new">创建一场</Link>}</Card>
        : <div className="card-list">{current.map((game) => <CurrentGameCard key={game.id} game={game} />)}</div>}
    </section>
  </div>;
}

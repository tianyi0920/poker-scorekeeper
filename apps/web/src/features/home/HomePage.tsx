import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { GameSnapshotDto } from '@poker/contracts';
import { scorekeeperApi } from '../../api/resources.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { Card } from '../../components/Card.js';
import { Toast } from '../../components/Toast.js';
import { CurrentGameCard } from './CurrentGameCard.js';
import { GAME_DELETED_NOTICE } from '../games/useGameDeletedSubscription.js';
import { HistoryPage } from '../history/HistoryPage.js';

const MAX_OPEN_GAMES = 5;

function readDeletedGameNotice(state: unknown): string | null {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return null;
  const record = state as Record<string, unknown>;
  return Object.keys(record).length === 1 && record.notice === GAME_DELETED_NOTICE
    ? GAME_DELETED_NOTICE
    : null;
}

function CurrentGamesPanel() {
  const { user } = useAuth();
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

  const canManageGames = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';
  const capacityReached = current.length >= MAX_OPEN_GAMES;

  return <section className="home-panel" id="current-games-panel" aria-labelledby="current-games-title">
      <h2 className="visually-hidden" id="current-games-title">当前对局</h2>
      <div className="section-heading">
        <span className="section-kicker">实时牌桌</span>
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
    </section>;
}

export function HomePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [notice] = useState(() => readDeletedGameNotice(location.state));
  const historyActive = new URLSearchParams(location.search).get('tab') === 'history';

  useEffect(() => {
    if (readDeletedGameNotice(location.state) !== null) {
      navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    }
  }, [location.pathname, location.search, location.state, navigate]);

  return <div className="page-stack home-page" aria-label="主页基础框架">
    {notice !== null && <p className="toast toast--info" role="status" aria-label="对局删除提示">{notice}</p>}
    <nav className="home-tabs" aria-label="首页内容" role="tablist">
      <Link to="/" role="tab" aria-selected={!historyActive} className={!historyActive ? 'active' : undefined}>当前对局</Link>
      <Link to="/?tab=history" role="tab" aria-selected={historyActive} className={historyActive ? 'active' : undefined}>历史战绩</Link>
    </nav>
    {historyActive ? <HistoryPage /> : <CurrentGamesPanel />}
  </div>;
}

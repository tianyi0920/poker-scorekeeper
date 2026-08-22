import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { GameSnapshotDto } from '@poker/contracts';
import { scorekeeperApi } from '../../api/resources.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { Card } from '../../components/Card.js';
import { Toast } from '../../components/Toast.js';
import { CurrentGameCard } from './CurrentGameCard.js';

export function HomePage() {
  const { user } = useAuth();
  const [current, setCurrent] = useState<GameSnapshotDto[]>([]);
  const [currentLoading, setCurrentLoading] = useState(true);
  const [currentError, setCurrentError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void scorekeeperApi.currentGames()
      .then((response) => { if (active) setCurrent(Array.isArray(response.games) ? response.games.slice(0, 2) : []); })
      .catch(() => { if (active) setCurrentError('当前对局暂时无法加载，请稍后重试'); })
      .finally(() => { if (active) setCurrentLoading(false); });
    return () => { active = false; };
  }, []);

  const canManageGames = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';

  return <div className="page-stack home-page" aria-label="主页基础框架">
    <section aria-labelledby="current-games-title">
      <div className="section-heading"><div><span className="section-kicker">LIVE TABLES</span><h2 id="current-games-title">当前对局</h2></div>{canManageGames && <Link className="compact-link" to="/games/new">创建对局</Link>}</div>
      {currentError !== null ? <Toast tone="error" message={currentError} /> : currentLoading ? <p className="muted">正在加载对局…</p> : current.length === 0
        ? <Card className="empty-card"><span aria-hidden="true">◇</span><p>当前没有进行中的对局</p>{canManageGames && <Link className="action-link" to="/games/new">创建一场</Link>}</Card>
        : <div className="card-list">{current.map((game) => <CurrentGameCard key={game.id} game={game} />)}</div>}
    </section>
  </div>;
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { GameSnapshotDto } from '@poker/contracts';
import { scorekeeperApi, type HistoryGameSummary } from '../../api/resources.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { Card } from '../../components/Card.js';
import { Money } from '../../components/Money.js';
import { Toast } from '../../components/Toast.js';
import { CurrentGameCard } from './CurrentGameCard.js';
import { RecentResultRow } from './RecentResultRow.js';

export function HomePage() {
  const { user } = useAuth();
  const [current, setCurrent] = useState<GameSnapshotDto[]>([]);
  const [history, setHistory] = useState<HistoryGameSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([scorekeeperApi.currentGames(), scorekeeperApi.recentHistory(10)])
      .then(([currentResponse, historyResponse]) => {
        if (!active) return;
        setCurrent(Array.isArray(currentResponse.games) ? currentResponse.games.slice(0, 2) : []);
        setHistory(Array.isArray(historyResponse.games) ? historyResponse.games.slice(0, 10) : []);
      })
      .catch(() => active && setError('首页数据暂时无法加载，请稍后重试'))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  const personalTotal = history.reduce((sum, game) => sum + BigInt(game.myFinalAmount ?? '0'), 0n).toString();
  const canManageGames = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';

  return <div className="page-stack home-page" aria-label="主页基础框架">
    <Card className="summary-card">
      <span className="section-kicker">个人摘要</span>
      <p>近 10 场最终金额</p>
      <strong className="hero-amount"><span aria-hidden="true">¥</span><Money value={personalTotal} /></strong>
      <span className="summary-caption">已加载 {history.length} 场已完成对局</span>
    </Card>
    {error !== null && <Toast tone="error" message={error} />}
    <section aria-labelledby="current-games-title">
      <div className="section-heading"><div><span className="section-kicker">LIVE TABLES</span><h2 id="current-games-title">当前对局</h2></div>{canManageGames && <Link className="compact-link" to="/games/new">创建对局</Link>}</div>
      {loading ? <p className="muted">正在加载对局…</p> : current.length === 0
        ? <Card className="empty-card"><span aria-hidden="true">◇</span><p>当前没有进行中的对局</p>{canManageGames && <Link className="action-link" to="/games/new">创建一场</Link>}</Card>
        : <div className="card-list">{current.map((game) => <CurrentGameCard key={game.id} game={game} />)}</div>}
    </section>
    <section aria-labelledby="recent-results-title">
      <div className="section-heading"><div><span className="section-kicker">RECENT RESULTS</span><h2 id="recent-results-title">最近战绩</h2></div><Link className="compact-link" to="/history">查看全部</Link></div>
      {!loading && history.length === 0 ? <Card className="empty-card"><p>还没有历史战绩</p></Card> : <div className="result-list">{history.map((game) => <RecentResultRow key={game.id} game={game} />)}</div>}
    </section>
  </div>;
}

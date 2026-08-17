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
  const [currentLoading, setCurrentLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void scorekeeperApi.currentGames()
      .then((response) => { if (active) setCurrent(Array.isArray(response.games) ? response.games.slice(0, 2) : []); })
      .catch(() => { if (active) setCurrentError('当前对局暂时无法加载，请稍后重试'); })
      .finally(() => { if (active) setCurrentLoading(false); });
    void scorekeeperApi.recentHistory(10)
      .then((response) => { if (active) setHistory(Array.isArray(response.games) ? response.games.slice(0, 10) : []); })
      .catch(() => { if (active) setHistoryError('最近战绩暂时无法加载，请稍后重试'); })
      .finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
  }, []);

  const personalTotal = history.reduce((sum, game) => sum + BigInt(game.myFinalAmount ?? '0'), 0n).toString();
  const canManageGames = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';

  return <div className="page-stack home-page" aria-label="主页基础框架">
    <Card className="summary-card">
      <span className="section-kicker">个人摘要</span>
      <p>近 10 场最终金额</p>
      {historyError === null ? <strong className="hero-amount"><span aria-hidden="true">¥</span><Money value={personalTotal} /></strong> : <strong className="hero-amount">—</strong>}
      <span className="summary-caption">{historyError === null ? historyLoading ? '正在计算最近战绩…' : `已加载 ${history.length} 场已完成对局` : '最近战绩加载失败，暂时无法统计'}</span>
    </Card>
    <section aria-labelledby="current-games-title">
      <div className="section-heading"><div><span className="section-kicker">LIVE TABLES</span><h2 id="current-games-title">当前对局</h2></div>{canManageGames && <Link className="compact-link" to="/games/new">创建对局</Link>}</div>
      {currentError !== null ? <Toast tone="error" message={currentError} /> : currentLoading ? <p className="muted">正在加载对局…</p> : current.length === 0
        ? <Card className="empty-card"><span aria-hidden="true">◇</span><p>当前没有进行中的对局</p>{canManageGames && <Link className="action-link" to="/games/new">创建一场</Link>}</Card>
        : <div className="card-list">{current.map((game) => <CurrentGameCard key={game.id} game={game} />)}</div>}
    </section>
    <section aria-labelledby="recent-results-title">
      <div className="section-heading"><div><span className="section-kicker">RECENT RESULTS</span><h2 id="recent-results-title">最近战绩</h2></div><Link className="compact-link" to="/history">查看全部</Link></div>
      {historyError !== null ? <Toast tone="error" message={historyError} /> : historyLoading ? <p className="muted">正在加载战绩…</p> : history.length === 0 ? <Card className="empty-card"><p>还没有历史战绩</p></Card> : <div className="result-list">{history.map((game) => <RecentResultRow key={game.id} game={game} />)}</div>}
    </section>
  </div>;
}

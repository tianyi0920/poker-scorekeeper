import type { HistoryListItemDto } from '@poker/contracts';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { scorekeeperApi } from '../../api/resources.js';
import { Card } from '../../components/Card.js';
import { formatSignedMoney } from '../../components/money-format.js';
import { Toast } from '../../components/Toast.js';
import { useOnlineStatus } from '../../hooks/useOnlineStatus.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { Button } from '../../components/Button.js';
import { readCachedHistory, writeCachedHistory } from './history-cache.js';

export function HistoryPage() {
  const online = useOnlineStatus(); const { user, isLoading: authLoading } = useAuth();
  const [items, setItems] = useState<HistoryListItemDto[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null); const [reload, setReload] = useState(0);
  useEffect(() => {
    if (user === null) { if (!authLoading) { setItems([]); setLoading(false); } return; }
    let active = true; const cached = readCachedHistory(user.id); setItems(cached?.items ?? []); setLoading(cached === null); setError(null);
    void scorekeeperApi.history(10).then((response) => {
      if (!active) return;
      writeCachedHistory(user.id, response);
      setItems(response.items); setError(null);
    }).catch(() => { if (active) setError(cached === null ? '历史战绩暂时无法加载，请稍后重试。' : '当前离线，正在展示已缓存的历史战绩。'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [authLoading, reload, user]);
  return <section className="page-stack history-panel" aria-labelledby="history-title">
    <h2 className="visually-hidden" id="history-title">历史战绩</h2>
    <Link className="monthly-ranking-entry" to="/history/monthly">
      <span className="monthly-ranking-entry__icon" aria-hidden="true">♠</span>
      <span className="monthly-ranking-entry__copy"><strong>月度排名</strong><small>看看本月牌桌上的盈利排行</small></span>
      <span className="monthly-ranking-entry__arrow" aria-hidden="true">›</span>
    </Link>
    <div className="history-list-heading"><div><span className="section-kicker">历史记录</span><h3>最近 10 局</h3></div><Link to="/history/select">选择牌局</Link></div>
    {error !== null && <><Toast tone={items.length > 0 ? 'info' : 'error'} message={error} /><Button variant="ghost" onClick={() => setReload((value) => value + 1)}>重试加载</Button></>}
    {loading ? <p className="muted">正在加载历史战绩…</p> : items.length === 0 ? <Card className="empty-card"><p>{online ? '还没有可查看的已完成对局' : '离线且没有可用的历史缓存'}</p></Card> : <div className="result-list">{items.map((item) => <Link className="result-row" key={item.gameId} to={`/history/${item.gameId}`}><div><strong>{item.name}</strong><span>{new Date(item.completedAt).toLocaleDateString('zh-CN')} · 结算人 {item.settledByNickname}</span></div><strong className="result-amount">{item.myFinalAmount === null ? '查看明细' : formatSignedMoney(item.myFinalAmount)}</strong></Link>)}</div>}
  </section>;
}

import type { HistoryListItemDto } from '@poker/contracts';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { scorekeeperApi } from '../../api/resources.js';
import { Card } from '../../components/Card.js';
import { Money } from '../../components/Money.js';
import { Toast } from '../../components/Toast.js';
import { useOnlineStatus } from '../../hooks/useOnlineStatus.js';

let cachedHistory: HistoryListItemDto[] | null = null;

export function HistoryPage() {
  const online = useOnlineStatus();
  const [items, setItems] = useState<HistoryListItemDto[]>(cachedHistory ?? []);
  const [loading, setLoading] = useState(cachedHistory === null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void scorekeeperApi.history(10).then((response) => {
      cachedHistory = response.items;
      if (active) { setItems(response.items); setError(null); }
    }).catch(() => { if (active) setError(cachedHistory === null ? '历史战绩暂时无法加载，请稍后重试。' : '当前离线，正在展示已缓存的历史战绩。'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  return <section className="page-stack" aria-labelledby="history-title">
    <header className="page-title"><span className="section-kicker">HISTORY</span><h2 id="history-title">历史战绩</h2><p>默认最近 10 局；仅显示服务器允许查看的已完成对局。</p></header>
    <div className="inline-actions"><Link className="button button--secondary" to="/history/select">选择牌局</Link><Link className="button button--primary" to="/history/summary?filter=RECENT_10">全员汇总</Link></div>
    {error !== null && <Toast tone={items.length > 0 ? 'info' : 'error'} message={error} />}
    {loading ? <p className="muted">正在加载历史战绩…</p> : items.length === 0 ? <Card className="empty-card"><p>{online ? '还没有可查看的已完成对局' : '离线且没有可用的历史缓存'}</p></Card> : <div className="result-list">{items.map((item) => <Link className="result-row" key={item.gameId} to={`/history/${item.gameId}`}><div><strong>{item.name}</strong><span>{new Date(item.completedAt).toLocaleDateString('zh-CN')} · 结算人 {item.settledByNickname}</span></div><strong className="result-amount"><span aria-hidden="true">¥</span><Money value={item.final} /></strong></Link>)}</div>}
  </section>;
}

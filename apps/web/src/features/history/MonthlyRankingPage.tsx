import type { AllPlayerAggregationDto, AllPlayerAggregationPlayerDto } from '@poker/contracts';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { scorekeeperApi } from '../../api/resources.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { Card } from '../../components/Card.js';
import { formatSignedMoney } from '../../components/money-format.js';
import { Button } from '../../components/Button.js';
import { Toast } from '../../components/Toast.js';
import { UserAvatar } from '../../components/UserAvatar.js';

interface RankingPeriod {
  year: number;
  month: number;
  tabLabel: string;
}

function shanghaiYearMonth(date: Date): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric'
  }).formatToParts(date);
  const year = Number(parts.find(({ type }) => type === 'year')?.value);
  const month = Number(parts.find(({ type }) => type === 'month')?.value);
  return { year, month };
}

export function monthlyRankingPeriods(now: Date): [RankingPeriod, RankingPeriod] {
  const current = shanghaiYearMonth(now);
  const previous = current.month === 1
    ? { year: current.year - 1, month: 12 }
    : { year: current.year, month: current.month - 1 };
  return [
    { ...current, tabLabel: `本月 · ${current.month}月` },
    { ...previous, tabLabel: `上月 · ${previous.month}月` }
  ];
}

function amountTone(finalAmount: string): string {
  const value = BigInt(finalAmount);
  return value > 0n ? 'money--positive' : value < 0n ? 'money--negative' : 'money--neutral';
}

function RankingRow({ player, rank, currentUserId }: {
  player: AllPlayerAggregationPlayerDto;
  rank: number;
  currentUserId: string | undefined;
}) {
  const isSelf = player.userId === currentUserId;
  return <li className={`ranking-row${isSelf ? ' ranking-row--self' : ''}`}>
    <span className={`ranking-position ranking-position--${Math.min(rank, 4)}`}>{rank}</span>
    <span className="ranking-player"><UserAvatar nickname={player.nickname} avatarUrl={player.avatarUrl} /><span><strong>{player.nickname}</strong>{isSelf && <small>我</small>}</span></span>
    <strong className={`ranking-amount ${amountTone(player.finalAmount)}`}>{formatSignedMoney(player.finalAmount)}</strong>
  </li>;
}

export function MonthlyRankingPage() {
  const { user } = useAuth();
  const [periods] = useState(() => monthlyRankingPeriods(new Date()));
  const [selectedIndex, setSelectedIndex] = useState<0 | 1>(0);
  const [data, setData] = useState<AllPlayerAggregationDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const period = periods[selectedIndex];

  useEffect(() => {
    let active = true;
    setLoading(true);
    setData(null);
    setError(null);
    void scorekeeperApi.aggregateHistory({
      filter: { kind: 'MY_MONTH', year: period.year, month: period.month }
    }).then((response) => {
      if (active) setData(response);
    }).catch(() => {
      if (active) setError('月度排名暂时无法加载，请稍后重试。');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [period.month, period.year, reload]);

  return <section className="monthly-ranking-page" aria-labelledby="monthly-ranking-title">
    <header className="ranking-topbar">
      <Link to="/?tab=history"><span aria-hidden="true">‹</span> 历史战绩</Link>
      <h2 id="monthly-ranking-title">月度排名</h2>
      <span aria-hidden="true" />
    </header>
    <div className="ranking-month-tabs" role="tablist" aria-label="排名月份">
      {periods.map((item, index) => <button
        key={`${item.year}-${item.month}`}
        type="button"
        role="tab"
        aria-selected={selectedIndex === index}
        onClick={() => setSelectedIndex(index as 0 | 1)}
      >{item.tabLabel}</button>)}
    </div>
    <div className="ranking-month-summary">
      <div><strong>{period.year}年{period.month}月</strong><span>{data === null ? '统计你参与的已结算牌局' : `统计你参与的 ${data.gameCount} 场已结算牌局`}</span></div>
      {data !== null && <span>{data.playerCount} 位玩家</span>}
    </div>
    <p className="ranking-note"><span aria-hidden="true">↗</span> 按最终盈利从高到低排列</p>
    {error !== null && <><Toast tone="error" message={error} /><Button variant="ghost" onClick={() => setReload((value) => value + 1)}>重试加载</Button></>}
    {loading ? <p className="muted">正在加载月度排名…</p> : data !== null && data.players.length === 0
      ? <Card className="empty-card"><span aria-hidden="true">◇</span><p>这个月还没有你参与的已结算牌局</p></Card>
      : data !== null && <div className="ranking-board" aria-label={`${period.year}年${period.month}月盈利排名`}>
        <div className="ranking-head"><span>排名</span><span>玩家</span><span>最终盈利</span></div>
        <ol>{data.players.map((player, index) => <RankingRow key={player.userId} player={player} rank={index + 1} currentUserId={user?.id} />)}</ol>
      </div>}
  </section>;
}

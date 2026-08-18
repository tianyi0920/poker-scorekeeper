import type { AllPlayerAggregationDto, AllPlayerAggregationPlayerDto } from '@poker/contracts';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { scorekeeperApi } from '../../api/resources.js';
import { Card } from '../../components/Card.js';
import { Money } from '../../components/Money.js';
import { Toast } from '../../components/Toast.js';

type AggregateRequest = Parameters<typeof scorekeeperApi.aggregateHistory>[0];
type QuickKind = 'RECENT_10' | 'RECENT_30' | 'LAST_30_DAYS' | 'LAST_90_DAYS';

function requestFromSearch(search: URLSearchParams): AggregateRequest {
  const gameIds = search.get('games');
  if (gameIds !== null) return { gameIds: gameIds.split(',').filter(Boolean) };
  const start = search.get('start'); const end = search.get('end');
  if (start !== null && end !== null) return { filter: { kind: 'CUSTOM_DATE_RANGE' as const, startAt: `${start}T00:00:00.000+08:00`, endAt: `${end}T23:59:59.999+08:00` } };
  const kind = search.get('filter');
  const quick: QuickKind = kind === 'RECENT_30' || kind === 'LAST_30_DAYS' || kind === 'LAST_90_DAYS' ? kind : 'RECENT_10';
  return { filter: { kind: quick } };
}

function PlayerAggregateCard({ player }: { player: AllPlayerAggregationPlayerDto }) {
  const [expanded, setExpanded] = useState(false);
  return <Card className="aggregate-card"><header className="aggregate-heading"><img src={player.avatarUrl} alt="" /><div><h3>{player.nickname}</h3><span>{player.gamesPlayed} 局 · 胜 {player.wins} · 负 {player.losses}</span></div><strong><Money value={player.finalAmount} /></strong></header><dl className="settlement-metrics"><div className="settlement-metric"><dt>累计牌局盈亏</dt><dd><Money value={player.rawProfit} /></dd></div><div className="settlement-metric expense-metric"><dt>累计房费</dt><dd>−¥{new Intl.NumberFormat('zh-CN').format(BigInt(player.roomFeeShare))}</dd></div><div className="settlement-metric expense-metric"><dt>累计其他费用</dt><dd>−¥{new Intl.NumberFormat('zh-CN').format(BigInt(player.otherFeeShare))}</dd></div><div className="settlement-metric"><dt>累计费用后盈亏（抽成前）</dt><dd><Money value={player.afterFeeProfit} /></dd></div><div className="settlement-metric rake-metric"><dt>累计抽成</dt><dd>−¥{new Intl.NumberFormat('zh-CN').format(BigInt(player.rakeAmount))}</dd></div><div className="settlement-metric"><dt>累计最终金额</dt><dd><Money value={player.finalAmount} /></dd></div></dl><button type="button" className="expand-button" aria-expanded={expanded} aria-controls={`games-${player.userId}`} aria-label={`${expanded ? '收起' : '展开'}${player.nickname}的逐局明细`} onClick={() => setExpanded((value) => !value)}>{expanded ? '收起逐局明细' : '展开逐局明细'}</button>{expanded && <ul id={`games-${player.userId}`} className="game-drilldown">{player.games.map((game) => <li key={game.gameId}><span>{game.gameName}<small>{new Date(game.completedAt).toLocaleDateString('zh-CN')}</small></span><strong><Money value={game.finalAmount} /></strong></li>)}</ul>}</Card>;
}

export function AllPlayerSummaryPage() {
  const [search] = useSearchParams(); const [data, setData] = useState<AllPlayerAggregationDto | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; const request = requestFromSearch(search); void scorekeeperApi.aggregateHistory(request).then((next) => { if (active) setData(next); }).catch(() => { if (active) setError('全员汇总暂时无法加载；服务器已保护可见对局范围。'); }); return () => { active = false; }; }, [search]);
  if (data === null) return <section className="page-stack"><p className="muted">正在汇总全员战绩…</p>{error !== null && <Toast tone="error" message={error} />}</section>;
  return <section className="page-stack" aria-labelledby="summary-title"><header className="page-title"><span className="section-kicker">ALL PLAYER SUMMARY</span><h2 id="summary-title">全员汇总</h2><p>{data.gameCount} 局 · {data.playerCount} 位玩家；顺序由服务器结算汇总返回。</p></header>{data.players.length === 0 ? <Card className="empty-card"><p>所选范围没有可汇总的结算记录。</p></Card> : <div className="card-list">{data.players.map((player) => <PlayerAggregateCard key={player.userId} player={player} />)}</div>}<Link className="secondary-link" to="/history/select">重新选择范围</Link></section>;
}

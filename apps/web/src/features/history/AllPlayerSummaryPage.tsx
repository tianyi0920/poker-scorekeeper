import type { AllPlayerAggregationDto, AllPlayerAggregationPlayerDto } from '@poker/contracts';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { scorekeeperApi } from '../../api/resources.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { formatSignedMoney, formatUnsignedMoney } from '../../components/money-format.js';
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

const FALLBACK_AVATAR = '/avatars/preset-01.webp';

function PlayerAvatar({ player }: { player: AllPlayerAggregationPlayerDto }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const source = failedSource === player.avatarUrl ? FALLBACK_AVATAR : player.avatarUrl;

  return (
    <img
      src={source}
      alt={`${player.nickname}的当前头像`}
      onError={() => {
        if (source !== FALLBACK_AVATAR) setFailedSource(player.avatarUrl);
      }}
    />
  );
}

function PlayerAggregateCard({ player }: { player: AllPlayerAggregationPlayerDto }) {
  const [expanded, setExpanded] = useState(false);
  const finalAmount = BigInt(player.finalAmount);
  const afterFeeAmount = BigInt(player.afterFeeProfit);
  const rakeAmount = BigInt(player.rakeAmount);
  const winner = finalAmount > 0n;
  const loser = finalAmount < 0n;
  const bankPaysPlayer = afterFeeAmount > 0n;
  const hasBankTransfer = afterFeeAmount !== 0n;
  const showsExpenseTransfer = winner || rakeAmount !== 0n;
  const hasFees = BigInt(player.roomFeeShare) !== 0n || BigInt(player.otherFeeShare) !== 0n;
  const actualLabel = winner ? '实际盈利合计' : loser ? '实际亏损合计' : '实际金额合计';
  const actualTone = winner ? 'positive' : loser ? 'negative' : 'neutral';

  return (
    <Card className={`aggregate-card aggregate-card--${actualTone}`}>
      <header className="aggregate-player-header">
        <div className="aggregate-player-identity">
          <PlayerAvatar player={player} />
          <div>
            <h3>{player.nickname}</h3>
            <span>{player.gamesPlayed} 局 · 胜 {player.wins} · 负 {player.losses}</span>
          </div>
        </div>
        <div className={`aggregate-actual money--${actualTone}`}>
          <span>{actualLabel}</span>
          <strong>{formatSignedMoney(player.finalAmount)}</strong>
        </div>
      </header>

      {hasBankTransfer || showsExpenseTransfer ? (
        <>
          <div className={`aggregate-transfer-grid${hasBankTransfer && showsExpenseTransfer ? '' : ' aggregate-transfer-grid--single'}`}>
            {hasBankTransfer && (
              <div className={`aggregate-transfer-action aggregate-transfer-action--${bankPaysPlayer ? 'bank' : 'loss'}`}>
                <span>{bankPaysPlayer ? '银行付款合计' : '转给银行合计'}</span>
                <strong>{formatUnsignedMoney(player.afterFeeProfit)}</strong>
                <small>{bankPaysPlayer
                  ? '费用后盈亏 · 抽成前应收'
                  : showsExpenseTransfer
                    ? '费用后实际亏损 · 经费单独计算'
                    : '理论转给银行 = 实际亏损合计 · 无需另付经费'}</small>
              </div>
            )}
            {showsExpenseTransfer && (
              <div className="aggregate-transfer-action aggregate-transfer-action--expense">
                <span>另付经费合计</span>
                <strong>{formatUnsignedMoney(player.rakeAmount)}</strong>
                <small>单独付给固定人员</small>
              </div>
            )}
          </div>
          {hasFees && (
            <p className="aggregate-fee-line">
              费用已计入：房费 {formatUnsignedMoney(player.roomFeeShare)} · 其他费用 {formatUnsignedMoney(player.otherFeeShare)}
            </p>
          )}
        </>
      ) : (
        <div className="aggregate-transfer-action aggregate-transfer-action--neutral">
          <span>本次无需转账</span>
          <strong>¥0</strong>
          <small>所选对局的实际收支为零</small>
        </div>
      )}

      <button
        type="button"
        className="aggregate-detail-toggle"
        aria-expanded={expanded}
        aria-controls={`games-${player.userId}`}
        aria-label={`${expanded ? '收起' : '展开'}${player.nickname}的逐局明细`}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>{expanded ? '收起逐局明细' : `查看 ${player.games.length} 局明细`}</span>
        <span className="aggregate-detail-chevron" aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
      </button>
      {expanded && (
        <ul id={`games-${player.userId}`} className="aggregate-game-list">
          {player.games.map((game) => (
            <li key={game.gameId}>
              <span>{game.gameName}<small>{new Date(game.completedAt).toLocaleDateString('zh-CN')}</small></span>
              <strong>{formatSignedMoney(game.finalAmount)}</strong>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function AllPlayerSummaryPage() {
  const [search] = useSearchParams();
  const [data, setData] = useState<AllPlayerAggregationDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    const request = requestFromSearch(search);
    setError(null);
    void scorekeeperApi.aggregateHistory(request)
      .then((next) => { if (active) setData(next); })
      .catch(() => { if (active) setError('全员汇总暂时无法加载；服务器已保护可见对局范围。'); });
    return () => { active = false; };
  }, [reload, search]);

  if (data === null) {
    return (
      <section className="page-stack">
        <p className="muted">正在汇总全员战绩…</p>
        {error !== null && (
          <>
            <Toast tone="error" message={error} />
            <Button variant="ghost" onClick={() => setReload((value) => value + 1)}>重试加载</Button>
          </>
        )}
      </section>
    );
  }

  return (
    <section className="page-stack" aria-labelledby="summary-title">
      <header className="page-title aggregate-page-heading">
        <span className="section-kicker">战绩汇总</span>
        <div>
          <h2 id="summary-title">全员汇总</h2>
          <Link to="/history/select">修改范围</Link>
        </div>
        <p>{data.gameCount} 场 · {data.playerCount} 位玩家</p>
        <small>按实际盈亏从高到低排列</small>
      </header>
      {data.players.length === 0 ? (
        <Card className="empty-card"><p>所选范围没有可汇总的结算记录。</p></Card>
      ) : (
        <div className="card-list">{data.players.map((player) => <PlayerAggregateCard key={player.userId} player={player} />)}</div>
      )}
      <Link className="secondary-link" to="/history">返回战绩</Link>
    </section>
  );
}

import { Link } from 'react-router-dom';
import type { HistoryGameSummary } from '../../api/resources.js';
import { Money } from '../../components/Money.js';

function durationLabel(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}小时${minutes > 0 ? `${minutes}分` : ''}`;
}

export function RecentResultRow({ game }: { game: HistoryGameSummary }) {
  return <Link to={`/history/${encodeURIComponent(game.id)}`} className="result-row" data-testid="recent-result">
    <div><strong>{game.name}</strong><span>{new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(game.completedAt))} · {durationLabel(game.durationSeconds)} · {game.playerCount}人</span></div>
    <span className="result-amount">{game.myFinalAmount === null ? '未参战' : <><span aria-hidden="true">¥</span><Money value={game.myFinalAmount} /></>}</span>
  </Link>;
}

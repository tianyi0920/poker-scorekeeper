import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { SettlementDetailDto } from '@poker/contracts';
import { scorekeeperApi } from '../../api/resources.js';
import { ApiError } from '../../api/http-client.js';
import { Toast } from '../../components/Toast.js';
import { SettlementBreakdown } from '../settlements/SettlementBreakdown.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { Button } from '../../components/Button.js';
import { type GameDeletedSocketFactory, useGameDeletedSubscription } from '../games/useGameDeletedSubscription.js';
import { readCachedSettlementDetail, removeCachedHistoryGame, writeCachedSettlementDetail } from './history-cache.js';

export function SettlementDetailPage({ socketFactory }: { socketFactory?: GameDeletedSocketFactory }) {
  const { id = '' } = useParams(); const navigate = useNavigate(); const { user, isLoading: authLoading } = useAuth(); const [detail, setDetail] = useState<SettlementDetailDto | null>(null); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(true); const [reload, setReload] = useState(0); const deletedRef = useRef(false);
  const leaveDeletedDetail = useCallback(() => {
    deletedRef.current = true;
    if (user !== null) removeCachedHistoryGame(user.id, id);
    setDetail(null); setError(null); setLoading(false);
    navigate('/history', { replace: true });
  }, [id, navigate, user]);
  useGameDeletedSubscription(user === null ? '' : id, leaveDeletedDetail, socketFactory, detail !== null);
  useEffect(() => { if (user === null || id === '') { if (!authLoading) setLoading(false); return; } let active = true; deletedRef.current = false; const cached = readCachedSettlementDetail(user.id, id); setDetail(cached); setLoading(cached === null); setError(null); void scorekeeperApi.historyDetail(id).then((next) => { if (!active || deletedRef.current) return; writeCachedSettlementDetail(user.id, next); setDetail(next); }).catch((reason) => { if (!active || deletedRef.current) return; if (reason instanceof ApiError && (reason.status === 403 || reason.status === 404)) { removeCachedHistoryGame(user.id, id); setDetail(null); setError('该历史结算不存在，或你没有查看权限。'); return; } setError(cached === null ? '该历史结算不存在，或你没有查看权限。' : '当前离线，正在展示已缓存的历史结算。'); }).finally(() => { if (active && !deletedRef.current) setLoading(false); }); return () => { active = false; }; }, [authLoading, id, reload, user]);
  if (detail === null) return <section className="page-stack"><p className="muted">{loading ? '正在读取历史结算…' : '没有可展示的历史结算。'}</p>{error !== null && <><Toast tone="error" message={error} /><Button variant="ghost" onClick={() => setReload((value) => value + 1)}>重试加载</Button></>}</section>;
  return <section className="page-stack"><header className="page-title"><span className="section-kicker">结算已锁定</span><h2>{detail.game.name}</h2><p>已由 {detail.settledByNickname} 永久锁定 · {new Date(detail.completedAt).toLocaleString('zh-CN')}</p></header>{error !== null && <><Toast tone="info" message={error} /><Button variant="ghost" onClick={() => setReload((value) => value + 1)}>重试加载</Button></>}<SettlementBreakdown breakdown={detail} mode="history" handPrice={detail.game.handPrice} />{detail.otherFeeNote !== '' && <p className="muted">其他费用说明：{detail.otherFeeNote}</p>}<Link className="secondary-link" to="/history">返回历史战绩</Link></section>;
}

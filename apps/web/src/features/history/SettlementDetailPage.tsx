import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { SettlementDetailDto } from '@poker/contracts';
import { scorekeeperApi } from '../../api/resources.js';
import { Toast } from '../../components/Toast.js';
import { SettlementBreakdown } from '../settlements/SettlementBreakdown.js';

export function SettlementDetailPage() {
  const { id = '' } = useParams(); const [detail, setDetail] = useState<SettlementDetailDto | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; void scorekeeperApi.historyDetail(id).then((next) => { if (active) setDetail(next); }).catch(() => { if (active) setError('该历史结算不存在，或你没有查看权限。'); }); return () => { active = false; }; }, [id]);
  if (detail === null) return <section className="page-stack"><p className="muted">正在读取历史结算…</p>{error !== null && <Toast tone="error" message={error} />}</section>;
  return <section className="page-stack"><header className="page-title"><span className="section-kicker">LOCKED SETTLEMENT</span><h2>{detail.game.name}</h2><p>已由 {detail.settledByNickname} 永久锁定 · {new Date(detail.completedAt).toLocaleString('zh-CN')}</p></header><SettlementBreakdown breakdown={detail} mode="history" />{detail.otherFeeNote !== '' && <p className="muted">其他费用说明：{detail.otherFeeNote}</p>}<Link className="secondary-link" to="/history">返回历史战绩</Link></section>;
}

import type { HistoryListItemDto } from '@poker/contracts';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { scorekeeperApi } from '../../api/resources.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Toast } from '../../components/Toast.js';
import { useOnlineStatus } from '../../hooks/useOnlineStatus.js';

export function GameSelectionPage() {
  const navigate = useNavigate();
  const online = useOnlineStatus();
  const [items, setItems] = useState<HistoryListItemDto[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [start, setStart] = useState(''); const [end, setEnd] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; void scorekeeperApi.history(50).then((response) => { if (active) setItems(response.items); }).catch(() => { if (active) setError('可选择的历史对局暂时无法加载。'); }); return () => { active = false; }; }, []);
  const selectFilter = (filter: string) => navigate(`/history/summary?filter=${filter}`);
  const submitCustom = () => { if (start === '' || end === '' || start > end) { setError('请选择有效的起止日期。'); return; } navigate(`/history/summary?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`); };
  return <section className="page-stack" aria-labelledby="selection-title"><header className="page-title"><span className="section-kicker">SELECT GAMES</span><h2 id="selection-title">选择汇总范围</h2><p>所有选项均由服务器在汇总时再次进行权限校验。</p></header>{error !== null && <Toast tone="error" message={error} />}<Card><div className="button-stack"><Button onClick={() => selectFilter('RECENT_10')}>最近 10 局</Button><Button variant="secondary" onClick={() => selectFilter('RECENT_30')}>最近 30 局</Button><Button variant="secondary" onClick={() => selectFilter('LAST_30_DAYS')}>最近 30 天</Button><Button variant="secondary" onClick={() => selectFilter('LAST_90_DAYS')}>最近 90 天</Button></div></Card><Card><h3>自定义日期</h3><div className="form-stack"><label className="field">开始日期<input type="date" value={start} onChange={(event) => setStart(event.target.value)} /></label><label className="field">结束日期<input type="date" value={end} onChange={(event) => setEnd(event.target.value)} /></label><Button disabled={!online} onClick={submitCustom}>按日期汇总</Button></div></Card><section><h3>选择可见对局</h3><div className="card-list">{items.map((item) => <label className="fee-candidate" key={item.gameId}><input type="checkbox" checked={selected.includes(item.gameId)} onChange={() => setSelected((current) => current.includes(item.gameId) ? current.filter((id) => id !== item.gameId) : [...current, item.gameId])} /><span><strong>{item.name}</strong><small>{new Date(item.completedAt).toLocaleDateString('zh-CN')}</small></span></label>)}</div>{items.length === 0 && <p className="muted">没有可选择的历史对局。</p>}<Button unsafe disabled={!online || selected.length === 0} onClick={() => navigate(`/history/summary?games=${encodeURIComponent(selected.join(','))}`)}>汇总已选 {selected.length} 局</Button></section></section>;
}

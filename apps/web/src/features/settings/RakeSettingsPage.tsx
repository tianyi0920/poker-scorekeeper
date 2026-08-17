import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/http-client.js';
import { mutationMessage, scorekeeperApi } from '../../api/resources.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Toast } from '../../components/Toast.js';

export function RakeSettingsPage() {
  const [threshold, setThreshold] = useState('');
  const [percent, setPercent] = useState('');
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function loadLatest() {
    const latest = await scorekeeperApi.getRakeSettings();
    setThreshold(latest.threshold);
    setPercent((latest.bps / 100).toString());
    setVersion(latest.version);
  }

  useEffect(() => {
    let active = true;
    void scorekeeperApi.getRakeSettings().then((latest) => {
      if (!active) return;
      setThreshold(latest.threshold);
      setPercent((latest.bps / 100).toString());
      setVersion(latest.version);
    }).catch((reason) => active && setError(mutationMessage(reason, '抽成规则加载失败')))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const bps = Math.round(Number(percent) * 100);
    if (!/^\d+$/.test(threshold) || !Number.isFinite(bps) || bps < 0 || bps > 10_000) {
      setError('门槛需为非负整数元，比例需在 0%–100% 之间');
      return;
    }
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const updated = await scorekeeperApi.updateRakeSettings({ threshold, bps, version });
      setThreshold(updated.threshold);
      setPercent((updated.bps / 100).toString());
      setVersion(updated.version);
      setConflicted(false);
      setSuccess('抽成规则已保存');
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        try {
          await loadLatest();
          setConflicted(true);
          setError('规则已被其他管理员更新，已载入最新值；请核对后再次确认保存。');
        } catch (reloadReason) {
          setError(mutationMessage(reloadReason, '规则冲突，且最新版本加载失败，请刷新页面'));
        }
      } else {
        setError(mutationMessage(reason, '保存抽成规则失败'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return <div className="page-stack narrow-page">
    <div className="page-title"><span className="section-kicker">RAKE RULE</span><h2>抽成设置</h2><p>规则对进行中与结算草稿实时生效；完成记录不会重算。</p></div>
    <Card>{loading ? <p className="muted">正在加载规则…</p> : <form className="form-stack" onSubmit={submit}>
      {error !== null && <Toast tone="error" message={error} />}
      {success !== null && <Toast tone="success" message={success} />}
      <div className="version-row"><span>当前规则版本</span><strong>v{version}</strong></div>
      <label className="field" htmlFor="rake-threshold">抽成门槛（元）<input id="rake-threshold" aria-label="抽成门槛（元）" type="number" inputMode="numeric" min="0" step="1" value={threshold} onChange={(event) => { setThreshold(event.target.value); setConflicted(false); }} required /><small>费用后盈亏大于或等于该金额时抽成</small></label>
      <label className="field" htmlFor="rake-percent">抽成比例（%）<input id="rake-percent" aria-label="抽成比例（%）" type="number" inputMode="decimal" min="0" max="100" step="0.01" value={percent} onChange={(event) => { setPercent(event.target.value); setConflicted(false); }} required /><small>后台按整数基点保存，10% = 1000 bps</small></label>
      <Button type="submit" unsafe disabled={submitting}>{submitting ? '保存中…' : conflicted ? '再次确认保存' : '保存抽成规则'}</Button>
    </form>}</Card>
  </div>;
}

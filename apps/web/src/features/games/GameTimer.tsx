import { useEffect, useMemo, useState } from 'react';

function formatDuration(totalMilliseconds: number): string {
  const seconds = Math.max(0, Math.floor(totalMilliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, '0')).join(':');
}

export function GameTimer({
  startedAt,
  stoppedAt,
  serverNow
}: {
  startedAt: string | null;
  stoppedAt: string | null;
  serverNow: string;
}) {
  const [clientNow, setClientNow] = useState(() => Date.now());
  const receivedAt = useMemo(() => Date.now(), [serverNow]);

  useEffect(() => {
    setClientNow(receivedAt);
  }, [receivedAt]);

  useEffect(() => {
    if (startedAt === null || stoppedAt !== null) return;
    const interval = window.setInterval(() => setClientNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [startedAt, stoppedAt]);

  if (startedAt === null) return <time>未开始</time>;
  const end = stoppedAt === null
    ? Date.parse(serverNow) + Math.max(0, clientNow - receivedAt)
    : Date.parse(stoppedAt);
  return <time dateTime={startedAt}>{formatDuration(end - Date.parse(startedAt))}</time>;
}

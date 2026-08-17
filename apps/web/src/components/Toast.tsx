export function Toast({ message, tone = 'info' }: { message: string; tone?: 'info' | 'error' | 'success' }) {
  return <p className={`toast toast--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{message}</p>;
}

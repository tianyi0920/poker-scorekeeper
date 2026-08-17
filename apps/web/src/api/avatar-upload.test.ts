import { afterEach, expect, it, vi } from 'vitest';
import { csrfTokenStore } from './http-client.js';
import { uploadAvatar } from './resources.js';

class FakeXhr {
  static latest: FakeXhr | null = null;
  readonly upload = { addEventListener: vi.fn((type: string, listener: (event: ProgressEvent) => void) => {
    if (type === 'progress') this.progressListener = listener;
  }) };
  readonly open = vi.fn();
  readonly setRequestHeader = vi.fn();
  readonly send = vi.fn();
  readonly abort = vi.fn(() => this.onabort?.());
  status = 200;
  responseText = JSON.stringify({ avatarKind: 'UPLOAD', avatarValue: 'saved.webp' });
  withCredentials = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private progressListener: ((event: ProgressEvent) => void) | null = null;

  constructor() { FakeXhr.latest = this; }
  progress(loaded: number, total: number) { this.progressListener?.({ lengthComputable: true, loaded, total } as ProgressEvent); }
}

afterEach(() => {
  vi.unstubAllGlobals();
  csrfTokenStore.clear();
  FakeXhr.latest = null;
});

it('aborts the in-flight XHR when its AbortSignal is cancelled', async () => {
  // Break caught: leaving the crop dialog allowed a hidden upload to complete and update stale UI.
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  const controller = new AbortController();
  const promise = uploadAvatar(new Blob(['avatar'], { type: 'image/webp' }), vi.fn(), controller.signal);
  const xhr = FakeXhr.latest!;

  controller.abort();

  expect(xhr.abort).toHaveBeenCalledOnce();
  await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
});

it('reports upload progress and sends the CSRF token with same-origin credentials', async () => {
  // Break caught: upload progress is absent or the mutation bypasses session/CSRF protection.
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  csrfTokenStore.set('csrf-123');
  const onProgress = vi.fn();
  const promise = uploadAvatar(new Blob(['avatar'], { type: 'image/webp' }), onProgress);
  const xhr = FakeXhr.latest!;

  xhr.progress(5, 10);
  xhr.onload?.();

  await expect(promise).resolves.toEqual({ avatarKind: 'UPLOAD', avatarValue: 'saved.webp' });
  expect(onProgress).toHaveBeenCalledWith(50);
  expect(xhr.open).toHaveBeenCalledWith('POST', '/api/me/avatar/upload');
  expect(xhr.withCredentials).toBe(true);
  expect(xhr.setRequestHeader).toHaveBeenCalledWith('X-CSRF-Token', 'csrf-123');
});

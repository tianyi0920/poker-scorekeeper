import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { AvatarPicker, cropAvatar } from './AvatarPicker.js';

const presets = Array.from({ length: 12 }, (_, index) => {
  const id = `preset-${String(index + 1).padStart(2, '0')}`;
  return { id, path: `/avatars/${id}.webp` };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

it('offers all twelve presets and keeps the old avatar visible until selection succeeds', async () => {
  // Break caught: optimistic avatar replacement displays a value the server has not committed.
  let resolveSelection!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/avatars/presets')) {
      return new Response(JSON.stringify({ presets }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/api/me/avatar/preset')) {
      return new Promise<Response>((resolve) => { resolveSelection = resolve; });
    }
    return new Response('{}', { status: 404 });
  }));

  const user = userEvent.setup();
  render(<AvatarPicker currentAvatar={{ kind: 'PRESET', value: 'preset-01' }} onChanged={() => undefined} />);

  expect(await screen.findAllByRole('button', { name: /选择预设头像/ })).toHaveLength(12);
  await user.click(screen.getByRole('button', { name: '选择预设头像 02' }));
  expect(screen.getByRole('img', { name: '当前头像' })).toHaveAttribute('src', '/avatars/preset-01.webp');

  resolveSelection(new Response(JSON.stringify({ avatarKind: 'PRESET', avatarValue: 'preset-02' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  }));
  await waitFor(() => expect(screen.getByRole('img', { name: '当前头像' })).toHaveAttribute('src', '/avatars/preset-02.webp'));
});

it('shows an unknown placeholder when the session has no avatar and selects only after a successful mutation', async () => {
  // Break caught: the profile claimed preset 01 was current even though the session contract supplied no avatar.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/avatars/presets')) return new Response(JSON.stringify({ presets }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/api/me/avatar/preset')) return new Response(JSON.stringify({ avatarKind: 'PRESET', avatarValue: 'preset-02' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('{}', { status: 404 });
  }));
  const user = userEvent.setup();
  render(<AvatarPicker currentAvatar={null} onChanged={() => undefined} />);

  expect(screen.getByText('当前头像尚未载入')).toBeInTheDocument();
  const choices = await screen.findAllByRole('button', { name: /选择预设头像/ });
  expect(choices.every((choice) => !choice.classList.contains('preset-avatar--active'))).toBe(true);

  await user.click(screen.getByRole('button', { name: '选择预设头像 02' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '选择预设头像 02' })).toHaveClass('preset-avatar--active'));
  expect(screen.getByRole('img', { name: '当前头像' })).toHaveAttribute('src', '/avatars/preset-02.webp');
});

it('aborts an upload and revokes its object URL when the picker unmounts', async () => {
  // Break caught: unmount left the XHR and blob URL alive, allowing late completion to mutate discarded state.
  class PendingXhr {
    static latest: PendingXhr | null = null;
    readonly upload = { addEventListener: vi.fn() };
    readonly open = vi.fn();
    readonly setRequestHeader = vi.fn();
    readonly send = vi.fn();
    readonly abort = vi.fn(() => this.onabort?.());
    status = 200;
    responseText = '{}';
    withCredentials = false;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    constructor() { PendingXhr.latest = this; }
  }
  class LoadedImage {
    naturalWidth = 1600;
    naturalHeight = 1200;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  }
  vi.stubGlobal('XMLHttpRequest', PendingXhr);
  vi.stubGlobal('Image', LoadedImage);
  const createObjectUrl = vi.fn(() => 'blob:avatar-test');
  const revoke = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ presets }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  const view = render(<AvatarPicker currentAvatar={null} onChanged={() => undefined} />);
  const originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
    if (tagName === 'canvas') return {
      width: 0, height: 0,
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (callback: BlobCallback) => callback(new Blob(['avatar'], { type: 'image/webp' }))
    } as unknown as HTMLCanvasElement;
    return originalCreateElement(tagName, options);
  }) as typeof document.createElement);

  fireEvent.change(await screen.findByLabelText('上传自定义头像'), {
    target: { files: [new File(['avatar'], 'avatar.png', { type: 'image/png' })] }
  });
  await screen.findByRole('dialog', { name: '裁剪头像' });
  fireEvent.click(screen.getByRole('button', { name: '裁剪并上传' }));
  await waitFor(() => expect(PendingXhr.latest).not.toBeNull());

  view.unmount();

  expect(PendingXhr.latest!.abort).toHaveBeenCalledOnce();
  expect(revoke).toHaveBeenCalledWith('blob:avatar-test');
});

it('rejects files larger than 5 MiB before opening a crop dialog', async () => {
  // Break caught: oversized input reaches decoding or upload instead of being rejected locally.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ presets }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })));
  render(<AvatarPicker currentAvatar={{ kind: 'PRESET', value: 'preset-01' }} onChanged={() => undefined} />);
  const file = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'too-big.png', { type: 'image/png' });

  fireEvent.change(await screen.findByLabelText('上传自定义头像'), { target: { files: [file] } });

  expect(await screen.findByRole('alert')).toHaveTextContent('图片不能超过 5 MiB');
  expect(screen.queryByRole('dialog', { name: '裁剪头像' })).not.toBeInTheDocument();
});

it('crops to a 512 square and rejects an encoding failure', async () => {
  // Break caught: crop output is not square or a null canvas encoding result is accepted.
  const drawImage = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ drawImage })),
    toBlob: vi.fn((callback: BlobCallback) => callback(new Blob(['avatar'], { type: 'image/webp' })))
  } as unknown as HTMLCanvasElement;
  vi.spyOn(document, 'createElement').mockReturnValue(canvas);
  const image = {} as HTMLImageElement;

  await expect(cropAvatar(image, { x: 10, y: 20, width: 200, height: 200 })).resolves.toBeInstanceOf(Blob);
  expect(canvas.width).toBe(512);
  expect(canvas.height).toBe(512);
  expect(drawImage).toHaveBeenCalledWith(image, 10, 20, 200, 200, 0, 0, 512, 512);

  (canvas.toBlob as unknown as ReturnType<typeof vi.fn>).mockImplementation((callback: BlobCallback) => callback(null));
  await expect(cropAvatar(image, { x: 0, y: 0, width: 10, height: 10 })).rejects.toThrow('AVATAR_ENCODE_FAILED');
});

it('disables every avatar mutation while offline', async () => {
  // Break caught: preset and custom avatar writes remain actionable without a network connection.
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ presets }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })));

  render(<AvatarPicker currentAvatar={{ kind: 'PRESET', value: 'preset-01' }} onChanged={() => undefined} />);

  for (const button of await screen.findAllByRole('button', { name: /选择预设头像/ })) {
    expect(button).toBeDisabled();
  }
  expect(screen.getByLabelText('上传自定义头像')).toBeDisabled();
});

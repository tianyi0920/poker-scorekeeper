import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { AvatarPicker, cropAvatar } from './AvatarPicker.js';

const presets = Array.from({ length: 12 }, (_, index) => {
  const id = `preset-${String(index + 13).padStart(2, '0')}`;
  return { id, path: `/avatars/${id}.webp` };
});

function avatarResponse(id: string): Response {
  return new Response(JSON.stringify({ avatarKind: 'PRESET', avatarValue: id }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function renderPicker({
  currentAvatar = { kind: 'PRESET', value: 'preset-13' } as const,
  onChanged = vi.fn()
}: {
  currentAvatar?: { kind: 'PRESET' | 'UPLOAD'; value: string } | null;
  onChanged?: ReturnType<typeof vi.fn>;
} = {}) {
  return { onChanged, ...render(<AvatarPicker currentAvatar={currentAvatar} onChanged={onChanged} />) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

it('does not save when a preset is only selected', async () => {
  // Break caught: a grid selection performs the avatar mutation before explicit confirmation.
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/avatars/presets')) {
      return new Response(JSON.stringify({ presets }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);

  const user = userEvent.setup();
  renderPicker();

  expect(await screen.findAllByRole('radio')).toHaveLength(12);
  await user.click(screen.getByRole('radio', { name: '头像 14' }));

  expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain('/api/me/avatar/preset');
  expect(screen.getByRole('radio', { name: '头像 14' })).toBeChecked();
  expect(screen.getByRole('button', { name: '保存头像' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '取消修改' })).toBeEnabled();
});

it('uses native radio keyboard selection without saving', async () => {
  // Break caught: keyboard users cannot stage a preset through the radio group.
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith('/api/avatars/presets')) return new Response(JSON.stringify({ presets }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  renderPicker();

  await screen.findByRole('radio', { name: '头像 13' });
  await user.tab();
  await user.keyboard('[ArrowRight]');

  expect(screen.getByRole('radio', { name: '头像 14' })).toBeChecked();
  expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain('/api/me/avatar/preset');
});

it('saves the pending preset once and refreshes the saved selection', async () => {
  // Break caught: confirmation either skips the mutation or leaves the saved selection stale after a successful response.
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/avatars/presets')) return new Response(JSON.stringify({ presets }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/api/me/avatar/preset')) return avatarResponse('preset-14');
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  const { onChanged } = renderPicker();

  await user.click(await screen.findByRole('radio', { name: '头像 14' }));
  await user.click(screen.getByRole('button', { name: '保存头像' }));

  await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/me/avatar/preset'))).toHaveLength(1));
  expect(onChanged).toHaveBeenCalledWith({ kind: 'PRESET', value: 'preset-14' });
  expect(screen.getByRole('status')).toHaveTextContent('头像已保存');
  expect(screen.queryByRole('button', { name: '保存头像' })).not.toBeInTheDocument();
  expect(screen.getByRole('radio', { name: '头像 14' })).toBeChecked();
});

it('ignores a delayed preset save after a newer session avatar arrives', async () => {
  // Break caught: an old write response overwrites the newer session avatar and reports a stale change.
  let resolveSelection!: (response: Response) => void;
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/avatars/presets')) return new Response(JSON.stringify({ presets }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/api/me/avatar/preset')) return new Promise<Response>((resolve) => { resolveSelection = resolve; });
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  const { onChanged, rerender } = renderPicker();

  await user.click(await screen.findByRole('radio', { name: '头像 14' }));
  await user.click(screen.getByRole('button', { name: '保存头像' }));
  rerender(<AvatarPicker currentAvatar={{ kind: 'PRESET', value: 'preset-15' }} onChanged={onChanged} />);
  await waitFor(() => expect(screen.getByRole('img', { name: '当前头像' })).toHaveAttribute('src', '/avatars/preset-15.webp'));
  expect(screen.getByRole('radio', { name: '头像 15' })).toBeDisabled();
  expect(screen.getByLabelText('上传自定义头像')).toBeDisabled();

  await act(async () => { resolveSelection(avatarResponse('preset-14')); });

  expect(screen.getByRole('img', { name: '当前头像' })).toHaveAttribute('src', '/avatars/preset-15.webp');
  expect(onChanged).not.toHaveBeenCalled();
  expect(screen.getByRole('radio', { name: '头像 15' })).toBeEnabled();
  expect(screen.getByLabelText('上传自定义头像')).toBeEnabled();
});

it('keeps avatar writes locked until a stale preset failure settles', async () => {
  // Break caught: an external session update unlocks controls before the superseded request has settled.
  let rejectSelection!: (reason: unknown) => void;
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/avatars/presets')) return new Response(JSON.stringify({ presets }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/api/me/avatar/preset')) return new Promise<Response>((_resolve, reject) => { rejectSelection = reject; });
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  const { onChanged, rerender } = renderPicker();

  await user.click(await screen.findByRole('radio', { name: '头像 14' }));
  await user.click(screen.getByRole('button', { name: '保存头像' }));
  rerender(<AvatarPicker currentAvatar={{ kind: 'PRESET', value: 'preset-15' }} onChanged={onChanged} />);
  await waitFor(() => expect(screen.getByRole('img', { name: '当前头像' })).toHaveAttribute('src', '/avatars/preset-15.webp'));
  expect(screen.getByRole('radio', { name: '头像 15' })).toBeDisabled();
  expect(screen.getByLabelText('上传自定义头像')).toBeDisabled();

  await act(async () => { rejectSelection(new Error('网络中断')); });

  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(onChanged).not.toHaveBeenCalled();
  expect(screen.getByRole('radio', { name: '头像 15' })).toBeEnabled();
  expect(screen.getByLabelText('上传自定义头像')).toBeEnabled();
});

it('clears saved feedback when an external session avatar replaces it', async () => {
  // Break caught: a success message remains after another session update has superseded it.
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/avatars/presets')) return new Response(JSON.stringify({ presets }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/api/me/avatar/preset')) return avatarResponse('preset-14');
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  const { rerender } = renderPicker();

  await user.click(await screen.findByRole('radio', { name: '头像 14' }));
  await user.click(screen.getByRole('button', { name: '保存头像' }));
  await screen.findByRole('status');
  rerender(<AvatarPicker currentAvatar={{ kind: 'PRESET', value: 'preset-15' }} onChanged={() => undefined} />);

  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  expect(screen.getByRole('img', { name: '当前头像' })).toHaveAttribute('src', '/avatars/preset-15.webp');
});

it('clears stale save errors when an external session avatar changes', async () => {
  // Break caught: an obsolete mutation error survives after the session supplies a new avatar.
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/avatars/presets')) return new Response(JSON.stringify({ presets }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/api/me/avatar/preset')) return new Response('{}', { status: 500, headers: { 'Content-Type': 'application/json' } });
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  const { rerender } = renderPicker();

  await user.click(await screen.findByRole('radio', { name: '头像 14' }));
  await user.click(screen.getByRole('button', { name: '保存头像' }));
  await screen.findByRole('alert');
  rerender(<AvatarPicker currentAvatar={{ kind: 'PRESET', value: 'preset-15' }} onChanged={() => undefined} />);

  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(screen.queryByRole('button', { name: '重试保存' })).not.toBeInTheDocument();
});

it('keeps saved feedback when the session refresh echoes the accepted avatar', async () => {
  // Break caught: the normal refresh after a successful save dismisses its confirmation immediately.
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/avatars/presets')) return new Response(JSON.stringify({ presets }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/api/me/avatar/preset')) return avatarResponse('preset-14');
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  const { rerender } = renderPicker();

  await user.click(await screen.findByRole('radio', { name: '头像 14' }));
  await user.click(screen.getByRole('button', { name: '保存头像' }));
  await screen.findByRole('status');
  rerender(<AvatarPicker currentAvatar={{ kind: 'PRESET', value: 'preset-14' }} onChanged={() => undefined} />);

  expect(screen.getByRole('status')).toHaveTextContent('头像已保存');
});

it('cancels a pending preset without requesting and restores the saved radio', async () => {
  // Break caught: cancel sends a write or leaves the unsaved choice selected.
  const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({ presets }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  renderPicker();

  await user.click(await screen.findByRole('radio', { name: '头像 14' }));
  await user.click(screen.getByRole('button', { name: '取消修改' }));

  expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain('/api/me/avatar/preset');
  expect(screen.getByRole('radio', { name: '头像 13' })).toBeChecked();
  expect(screen.queryByRole('button', { name: '保存头像' })).not.toBeInTheDocument();
});

it('keeps a failed pending preset and offers a retry that saves it', async () => {
  // Break caught: a failed save discards the selected avatar or provides no usable retry.
  let saveAttempts = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/avatars/presets')) return new Response(JSON.stringify({ presets }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/api/me/avatar/preset')) {
      saveAttempts += 1;
      return saveAttempts === 1
        ? new Response(JSON.stringify({ message: '保存失败，请重试' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
        : avatarResponse('preset-14');
    }
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  const { onChanged } = renderPicker();

  await user.click(await screen.findByRole('radio', { name: '头像 14' }));
  await user.click(screen.getByRole('button', { name: '保存头像' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('请求失败，请稍后重试');
  expect(screen.getByRole('radio', { name: '头像 14' })).toBeChecked();
  expect(screen.getByRole('button', { name: '重试保存' })).toBeEnabled();

  await user.click(screen.getByRole('button', { name: '重试保存' }));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/me/avatar/preset'))).toHaveLength(2));
  expect(onChanged).toHaveBeenCalledWith({ kind: 'PRESET', value: 'preset-14' });
});

it('prevents duplicate preset saves while the request is pending', async () => {
  // Break caught: multiple confirmation clicks create more than one concurrent avatar write.
  let resolveSelection!: (value: Response) => void;
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/avatars/presets')) return new Response(JSON.stringify({ presets }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/api/me/avatar/preset')) return new Promise<Response>((resolve) => { resolveSelection = resolve; });
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  renderPicker();

  await user.click(await screen.findByRole('radio', { name: '头像 14' }));
  const save = screen.getByRole('button', { name: '保存头像' });
  await user.click(save);
  await user.click(save);

  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/me/avatar/preset'))).toHaveLength(1);
  expect(save).toBeDisabled();
  expect(screen.getByRole('radio', { name: '头像 15' })).toBeDisabled();

  resolveSelection(avatarResponse('preset-14'));
  await waitFor(() => expect(screen.queryByRole('button', { name: '保存头像' })).not.toBeInTheDocument());
});

it('keeps the changed save control visible but disabled after going offline', async () => {
  // Break caught: losing network hides the unsaved state instead of preventing its mutation.
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ presets }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  const user = userEvent.setup();
  renderPicker();

  await user.click(await screen.findByRole('radio', { name: '头像 14' }));
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  fireEvent(window, new Event('offline'));

  await waitFor(() => expect(screen.getByRole('button', { name: '保存头像' })).toBeDisabled());
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

  for (const radio of await screen.findAllByRole('radio')) {
    expect(radio).toBeDisabled();
  }
  expect(screen.getByLabelText('上传自定义头像')).toBeDisabled();
});

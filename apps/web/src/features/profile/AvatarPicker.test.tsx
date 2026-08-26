import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/http-client.js';
import * as avatarResources from '../../api/resources.js';
import { AvatarPicker, cropAvatar } from './AvatarPicker.js';

const presets = Array.from({ length: 12 }, (_, index) => {
  const id = `preset-${String(index + 13).padStart(2, '0')}`;
  return { id, path: `/avatars/${id}.webp` };
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderPicker({
  currentAvatar = { kind: 'PRESET', value: 'preset-13' } as const,
  onChanged = vi.fn(),
  nickname = '头像用户'
}: {
  currentAvatar?: { kind: 'PRESET' | 'UPLOAD'; value: string } | null;
  onChanged?: ReturnType<typeof vi.fn>;
  nickname?: string;
} = {}) {
  return { onChanged, ...render(<AvatarPicker nickname={nickname} currentAvatar={currentAvatar} onChanged={onChanged} />) };
}

function stubPresetFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ presets }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })));
}

function installCropHarness(
  croppedBlob = new Blob(['cropped-avatar'], { type: 'image/webp' }),
  canvasAvailable = true
) {
  class LoadedImage {
    naturalWidth = 1600;
    naturalHeight = 1200;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  }
  vi.stubGlobal('Image', LoadedImage);
  const createObjectUrl = vi.fn()
    .mockReturnValueOnce('blob:avatar-source-1')
    .mockReturnValueOnce('blob:avatar-source-2');
  const revokeObjectUrl = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
  const originalCreateElement = document.createElement.bind(document);
  const encodeCrop = vi.fn((callback: BlobCallback) => callback(croppedBlob));
  vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
    if (tagName === 'canvas') return {
      width: 0,
      height: 0,
      getContext: () => canvasAvailable ? { drawImage: vi.fn() } : null,
      toBlob: encodeCrop
    } as unknown as HTMLCanvasElement;
    return originalCreateElement(tagName, options);
  }) as typeof document.createElement);
  return { createObjectUrl, revokeObjectUrl, encodeCrop, croppedBlob };
}

async function chooseImage(fileName = 'avatar.png') {
  fireEvent.change(await screen.findByLabelText('从相册选择文件'), {
    target: { files: [new File(['avatar'], fileName, { type: 'image/png' })] }
  });
  await screen.findByRole('dialog', { name: '裁剪头像' });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

it('uses a keyboard-operable album button while keeping the exact file input accessible and visually hidden', async () => {
  // Break caught: browser-native file chrome is visible or keyboard users cannot open the system picker.
  stubPresetFetch();
  const user = userEvent.setup();
  renderPicker();

  const input = await screen.findByLabelText('从相册选择文件');
  expect(input).toHaveClass('visually-hidden-file-input');
  expect(input).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
  expect(screen.queryByText('选择文件')).not.toBeInTheDocument();
  expect(screen.queryByText('未选择任何文件')).not.toBeInTheDocument();
  const inputClick = vi.spyOn(input, 'click');
  const albumButton = screen.getByRole('button', { name: '从相册选择' });

  albumButton.focus();
  await user.keyboard('[Enter]');

  expect(albumButton).toHaveFocus();
  expect(inputClick).toHaveBeenCalledOnce();
});

it('opens crop after selection and uploads only after crop confirmation', async () => {
  // Break caught: selecting a file bypasses crop confirmation and starts a write immediately.
  stubPresetFetch();
  installCropHarness();
  const upload = vi.spyOn(avatarResources, 'uploadAvatar').mockImplementation(() => new Promise(() => undefined));
  renderPicker();

  await chooseImage();
  expect(upload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '裁剪并上传' }));

  await waitFor(() => expect(upload).toHaveBeenCalledOnce());
});

it('announces actual upload progress from the upload API without a timer', async () => {
  // Break caught: the UI fabricates progress or fails to announce the XHR byte percentage.
  stubPresetFetch();
  installCropHarness();
  let reportProgress!: (percent: number) => void;
  vi.spyOn(avatarResources, 'uploadAvatar').mockImplementation((_blob, onProgress) => {
    reportProgress = onProgress;
    return new Promise(() => undefined);
  });
  renderPicker();

  await chooseImage();
  fireEvent.click(screen.getByRole('button', { name: '裁剪并上传' }));
  await waitFor(() => expect(reportProgress).toBeTypeOf('function'));
  expect(screen.getByRole('status')).toHaveTextContent('正在上传 0%');

  act(() => reportProgress(37));

  expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  expect(screen.getByRole('status')).toHaveTextContent('正在上传 37%');
  expect(screen.getByRole('progressbar', { name: '头像上传进度' })).toHaveAttribute('value', '37');
});

it('keeps the same cropped blob and preview after failure and releases them only after retry succeeds', async () => {
  // Break caught: a failed upload discards or re-encodes the crop, or revokes its preview before retry.
  stubPresetFetch();
  const harness = installCropHarness();
  const upload = vi.spyOn(avatarResources, 'uploadAvatar')
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce({ avatarKind: 'UPLOAD', avatarValue: 'saved.webp' });
  const { onChanged } = renderPicker();

  await chooseImage();
  fireEvent.click(screen.getByRole('button', { name: '裁剪并上传' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('上传失败，请重试');
  expect(screen.getByRole('img', { name: '待裁剪头像' })).toHaveAttribute('src', 'blob:avatar-source-1');
  expect(screen.getByRole('button', { name: '重新上传' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '重新选择照片' })).toBeEnabled();
  expect(harness.revokeObjectUrl).not.toHaveBeenCalled();
  expect(harness.encodeCrop).toHaveBeenCalledOnce();
  expect(screen.getByRole('img', { name: '当前头像' })).toHaveTextContent('头');

  fireEvent.click(screen.getByRole('button', { name: '重新上传' }));

  await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
  expect(upload.mock.calls[1]![0]).toBe(upload.mock.calls[0]![0]);
  expect(upload.mock.calls[0]![0]).toBe(harness.croppedBlob);
  expect(harness.encodeCrop).toHaveBeenCalledOnce();
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ kind: 'UPLOAD', value: 'saved.webp' }));
  expect(harness.revokeObjectUrl).toHaveBeenCalledWith('blob:avatar-source-1');
});

it('preserves a structured avatar API error while retaining retry actions and the preview', async () => {
  // Break caught: authentication, CSRF, format or server messages are flattened into a generic upload error.
  stubPresetFetch();
  const harness = installCropHarness();
  vi.spyOn(avatarResources, 'uploadAvatar').mockRejectedValue(new ApiError(
    415,
    'AVATAR_UNSUPPORTED',
    '仅支持 JPG、PNG 或 WebP 图片'
  ));
  renderPicker();

  await chooseImage();
  fireEvent.click(screen.getByRole('button', { name: '裁剪并上传' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('仅支持 JPG、PNG 或 WebP 图片');
  expect(screen.getByRole('button', { name: '重新上传' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '重新选择照片' })).toBeEnabled();
  expect(screen.getByRole('img', { name: '待裁剪头像' })).toHaveAttribute('src', 'blob:avatar-source-1');
  expect(harness.revokeObjectUrl).not.toHaveBeenCalled();
});

it('does not offer Blob retry when local crop encoding fails before upload starts', async () => {
  // Break caught: retry is advertised without a retained Blob and silently performs a second crop.
  stubPresetFetch();
  installCropHarness(new Blob(['unused'], { type: 'image/webp' }), false);
  const upload = vi.spyOn(avatarResources, 'uploadAvatar');
  renderPicker();

  await chooseImage();
  fireEvent.click(screen.getByRole('button', { name: '裁剪并上传' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('上传失败，请重试');
  expect(upload).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '重新上传' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '裁剪并上传' })).toBeEnabled();
});

it('shows the successful upload response locally before the refreshed session echoes it', async () => {
  // Break caught: a successful upload leaves the stale avatar visible while session refresh is pending.
  stubPresetFetch();
  installCropHarness();
  vi.spyOn(avatarResources, 'uploadAvatar').mockResolvedValue({ avatarKind: 'UPLOAD', avatarValue: 'saved.webp' });
  const onChanged = vi.fn();
  const view = render(<AvatarPicker currentAvatar={{ kind: 'PRESET', value: 'preset-13' }} onChanged={onChanged} />);

  await chooseImage();
  fireEvent.click(screen.getByRole('button', { name: '裁剪并上传' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ kind: 'UPLOAD', value: 'saved.webp' }));

  expect(screen.getByRole('img', { name: '当前头像' })).toHaveAttribute('src', '/avatars/uploads/saved.webp');
  view.rerender(<AvatarPicker currentAvatar={{ kind: 'UPLOAD', value: 'saved.webp' }} onChanged={onChanged} />);
  expect(screen.getByRole('img', { name: '当前头像' })).toHaveAttribute('src', '/avatars/uploads/saved.webp');
  expect(screen.getByRole('status')).toHaveTextContent('头像已保存');
});

it('keeps an accepted upload locally and retries only session synchronization after it rejects', async () => {
  // Break caught: a session refresh failure reverts a successful upload, retains the crop, or retries the Blob upload.
  stubPresetFetch();
  installCropHarness();
  const upload = vi.spyOn(avatarResources, 'uploadAvatar').mockResolvedValue({ avatarKind: 'UPLOAD', avatarValue: 'saved.webp' });
  const onChanged = vi.fn()
    .mockRejectedValueOnce(new Error('session refresh failed'))
    .mockResolvedValueOnce(undefined);
  const user = userEvent.setup();
  renderPicker({ onChanged });

  await chooseImage();
  await user.click(screen.getByRole('button', { name: '裁剪并上传' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('头像已保存，但页面状态同步失败');
  expect(screen.getByRole('img', { name: '当前头像' })).toHaveAttribute('src', '/avatars/uploads/saved.webp');
  expect(screen.getByRole('status')).toHaveTextContent('头像已保存');
  expect(screen.queryByRole('dialog', { name: '裁剪头像' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '重新上传' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重试页面状态同步' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '从相册选择' })).toBeDisabled();
  expect(upload).toHaveBeenCalledOnce();

  await user.click(screen.getByRole('button', { name: '重试页面状态同步' }));

  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
  expect(upload).toHaveBeenCalledOnce();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('img', { name: '当前头像' })).toHaveAttribute('src', '/avatars/uploads/saved.webp');
  expect(screen.getByRole('status')).toHaveTextContent('头像已保存');
  expect(screen.getByRole('button', { name: '从相册选择' })).toBeEnabled();
});

it('prioritizes a newer external session avatar over a late rejected upload synchronization', async () => {
  // Break caught: a stale synchronization failure replaces a newer session avatar with obsolete local feedback.
  stubPresetFetch();
  installCropHarness();
  const sessionSync = deferred();
  vi.spyOn(avatarResources, 'uploadAvatar').mockResolvedValue({ avatarKind: 'UPLOAD', avatarValue: 'saved.webp' });
  const onChanged = vi.fn(() => sessionSync.promise);
  const view = render(<AvatarPicker currentAvatar={{ kind: 'PRESET', value: 'preset-13' }} onChanged={onChanged} />);

  await chooseImage();
  fireEvent.click(screen.getByRole('button', { name: '裁剪并上传' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ kind: 'UPLOAD', value: 'saved.webp' }));
  expect(screen.getByRole('img', { name: '当前头像' })).toHaveAttribute('src', '/avatars/uploads/saved.webp');

  view.rerender(<AvatarPicker currentAvatar={{ kind: 'PRESET', value: 'preset-15' }} onChanged={onChanged} />);
  await act(async () => sessionSync.reject(new Error('stale session refresh failed')));

  expect(screen.getByRole('img', { name: '当前头像' })).toHaveTextContent('用');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '重试页面状态同步' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '从相册选择' })).toBeEnabled();
});

it('does not set synchronization failure state after an upload picker unmounts', async () => {
  // Break caught: a rejected session callback after unmount schedules avatar feedback on the disposed picker.
  stubPresetFetch();
  installCropHarness();
  const sessionSync = deferred();
  vi.spyOn(avatarResources, 'uploadAvatar').mockResolvedValue({ avatarKind: 'UPLOAD', avatarValue: 'saved.webp' });
  const onChanged = vi.fn(() => sessionSync.promise);
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const view = render(<AvatarPicker currentAvatar={{ kind: 'PRESET', value: 'preset-13' }} onChanged={onChanged} />);

  await chooseImage();
  fireEvent.click(screen.getByRole('button', { name: '裁剪并上传' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  view.unmount();
  await act(async () => sessionSync.reject(new Error('late session refresh failed')));

  expect(consoleError).not.toHaveBeenCalled();
});

it('keeps upload and modal writes locked until the accepted upload finishes session synchronization', async () => {
  // Break caught: a completed upload closes the crop and permits a second write before session synchronization settles.
  stubPresetFetch();
  installCropHarness();
  const sessionSync = deferred();
  const upload = vi.spyOn(avatarResources, 'uploadAvatar').mockImplementation(async (_blob, onProgress) => {
    onProgress(100);
    return { avatarKind: 'UPLOAD', avatarValue: 'saved.webp' };
  });
  const onChanged = vi.fn(() => sessionSync.promise);
  const view = render(<AvatarPicker currentAvatar={{ kind: 'PRESET', value: 'preset-13' }} onChanged={onChanged} />);

  await chooseImage();
  fireEvent.click(screen.getByRole('button', { name: '裁剪并上传' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith({ kind: 'UPLOAD', value: 'saved.webp' }));

  expect(screen.getByRole('img', { name: '当前头像' })).toHaveAttribute('src', '/avatars/uploads/saved.webp');
  expect(screen.getByRole('dialog', { name: '裁剪头像' })).toBeInTheDocument();
  expect(screen.getByText('正在上传 100%')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '从相册选择' })).toBeDisabled();
  expect(screen.getByLabelText('从相册选择文件')).toBeDisabled();
  expect(screen.getByLabelText('水平位置')).toBeDisabled();
  expect(screen.getByRole('button', { name: '裁剪并上传' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '关闭' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '裁剪并上传' }));
  expect(upload).toHaveBeenCalledOnce();

  view.rerender(<AvatarPicker currentAvatar={{ kind: 'UPLOAD', value: 'saved.webp' }} onChanged={onChanged} />);
  expect(screen.getByRole('img', { name: '当前头像' })).toHaveAttribute('src', '/avatars/uploads/saved.webp');
  expect(screen.getByRole('dialog', { name: '裁剪头像' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '从相册选择' })).toBeDisabled();

  await act(async () => sessionSync.resolve());

  expect(screen.queryByRole('dialog', { name: '裁剪头像' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '从相册选择' })).toBeEnabled();
  expect(screen.getByLabelText('从相册选择文件')).toBeEnabled();
  expect(screen.getByRole('status')).toHaveTextContent('头像已保存');
  expect(upload).toHaveBeenCalledOnce();
});

it('ignores a delayed upload success after a newer session avatar arrives', async () => {
  // Break caught: an old upload response overwrites the newer authenticated session avatar.
  stubPresetFetch();
  installCropHarness();
  let resolveUpload!: (avatar: { avatarKind: 'UPLOAD'; avatarValue: string }) => void;
  vi.spyOn(avatarResources, 'uploadAvatar').mockImplementation(() => new Promise((resolve) => {
    resolveUpload = resolve;
  }));
  const onChanged = vi.fn();
  const view = render(<AvatarPicker currentAvatar={{ kind: 'PRESET', value: 'preset-13' }} onChanged={onChanged} />);

  await chooseImage();
  fireEvent.click(screen.getByRole('button', { name: '裁剪并上传' }));
  await screen.findByText('正在上传 0%');
  view.rerender(<AvatarPicker currentAvatar={{ kind: 'PRESET', value: 'preset-15' }} onChanged={onChanged} />);

  await act(async () => resolveUpload({ avatarKind: 'UPLOAD', avatarValue: 'stale.webp' }));

  expect(screen.getByRole('img', { name: '当前头像' })).toHaveTextContent('用');
  expect(onChanged).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '从相册选择' })).toBeEnabled();
});

it('ignores a delayed upload failure after a newer session avatar arrives', async () => {
  // Break caught: a superseded upload paints an obsolete error over the newer authenticated session state.
  stubPresetFetch();
  installCropHarness();
  let rejectUpload!: (reason: unknown) => void;
  vi.spyOn(avatarResources, 'uploadAvatar').mockImplementation(() => new Promise((_resolve, reject) => {
    rejectUpload = reject;
  }));
  const onChanged = vi.fn();
  const view = render(<AvatarPicker currentAvatar={{ kind: 'PRESET', value: 'preset-13' }} onChanged={onChanged} />);

  await chooseImage();
  fireEvent.click(screen.getByRole('button', { name: '裁剪并上传' }));
  await screen.findByText('正在上传 0%');
  view.rerender(<AvatarPicker currentAvatar={{ kind: 'PRESET', value: 'preset-15' }} onChanged={onChanged} />);

  await act(async () => rejectUpload(new Error('stale network failure')));

  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(onChanged).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '从相册选择' })).toBeEnabled();
});

it('discards the failed crop before opening a replacement selection', async () => {
  // Break caught: reselecting leaks the retained preview or silently retries the old crop.
  stubPresetFetch();
  const harness = installCropHarness();
  vi.spyOn(avatarResources, 'uploadAvatar').mockRejectedValue(new Error('network'));
  renderPicker();

  await chooseImage();
  fireEvent.click(screen.getByRole('button', { name: '裁剪并上传' }));
  await screen.findByRole('alert');
  const input = screen.getByLabelText('从相册选择文件');
  const inputClick = vi.spyOn(input, 'click');

  fireEvent.click(screen.getByRole('button', { name: '重新选择照片' }));

  expect(harness.revokeObjectUrl).toHaveBeenCalledWith('blob:avatar-source-1');
  expect(inputClick).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog', { name: '裁剪头像' })).not.toBeInTheDocument();
});

it('releases the old object URL when a file selection replaces it', async () => {
  // Break caught: selecting another file overwrites the source reference without releasing the old object URL.
  stubPresetFetch();
  const harness = installCropHarness();
  renderPicker();

  await chooseImage('first.png');
  fireEvent.change(screen.getByLabelText('从相册选择文件'), {
    target: { files: [new File(['replacement'], 'second.png', { type: 'image/png' })] }
  });

  await waitFor(() => expect(harness.createObjectUrl).toHaveBeenCalledTimes(2));
  expect(harness.revokeObjectUrl).toHaveBeenCalledWith('blob:avatar-source-1');
  expect(await screen.findByRole('img', { name: '待裁剪头像' })).toHaveAttribute('src', 'blob:avatar-source-2');
});

it('releases the object URL when crop is explicitly cancelled', async () => {
  // Break caught: cancelling the crop hides the dialog but leaks its source preview URL.
  stubPresetFetch();
  const harness = installCropHarness();
  renderPicker();

  await chooseImage();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));

  expect(harness.revokeObjectUrl).toHaveBeenCalledWith('blob:avatar-source-1');
  expect(screen.queryByRole('dialog', { name: '裁剪头像' })).not.toBeInTheDocument();
});

it('disables album, file and crop writes for the whole upload request', async () => {
  // Break caught: a concurrent avatar or crop write remains enabled while an upload is pending.
  stubPresetFetch();
  installCropHarness();
  vi.spyOn(avatarResources, 'uploadAvatar').mockImplementation(() => new Promise(() => undefined));
  renderPicker();

  await chooseImage();
  fireEvent.click(screen.getByRole('button', { name: '裁剪并上传' }));
  await screen.findByText('正在上传 0%');

  expect(screen.getByRole('button', { name: '从相册选择' })).toBeDisabled();
  expect(screen.getByLabelText('从相册选择文件')).toBeDisabled();
  expect(screen.getByLabelText('水平位置')).toBeDisabled();
  expect(screen.getByLabelText('垂直位置')).toBeDisabled();
  expect(screen.getByRole('button', { name: '裁剪并上传' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
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

  fireEvent.change(await screen.findByLabelText('从相册选择文件'), {
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

  fireEvent.change(await screen.findByLabelText('从相册选择文件'), { target: { files: [file] } });

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

it('disables avatar upload while offline', async () => {
  // Break caught: custom avatar writes remain actionable without a network connection.
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ presets }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })));

  render(<AvatarPicker currentAvatar={{ kind: 'PRESET', value: 'preset-01' }} onChanged={() => undefined} />);

  expect(screen.getByLabelText('从相册选择文件')).toBeDisabled();
  expect(screen.getByRole('button', { name: '从相册选择' })).toBeDisabled();
});

it('shows the nickname initial for legacy preset avatars without loading a preset gallery', () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  renderPicker({ nickname: ' 头像用户' });

  expect(screen.getByRole('img', { name: '当前头像' })).toHaveTextContent('头');
  expect(screen.queryByRole('radiogroup', { name: '默认头像' })).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

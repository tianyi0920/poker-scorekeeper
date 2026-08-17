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

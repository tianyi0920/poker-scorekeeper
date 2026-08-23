import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AvatarCropDialog, cropPreviewStyle } from './AvatarCropDialog.js';

function largeImage(): HTMLImageElement {
  return { naturalWidth: 4000, naturalHeight: 3000 } as HTMLImageElement;
}

it('scales and offsets a non-origin crop rectangle into the 260px preview', () => {
  // Break caught: the preview rendered a 4000px image at intrinsic scale and did not match the uploaded crop.
  expect(cropPreviewStyle(largeImage(), { x: 500, y: 250, width: 2000, height: 2000 })).toEqual({
    width: '520px',
    height: '390px',
    transform: 'translate(-65px, -32.5px)'
  });
});

it('blocks close button, Escape and backdrop dismissal while upload is busy', () => {
  // Break caught: local cancellation unlocks a second write while the first request may commit remotely.
  const onClose = vi.fn();
  const props = {
    sourceUrl: 'blob:avatar', image: largeImage(),
    crop: { x: 500, y: 250, width: 2000, height: 2000 },
    busy: true, progress: 40, onCropChange: vi.fn(), onConfirm: vi.fn(), onClose
  };
  const view = render(<AvatarCropDialog {...props} />);

  expect(screen.getByRole('button', { name: '关闭' })).toBeDisabled();
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.mouseDown(view.container.querySelector('.modal-backdrop')!);
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(onClose).not.toHaveBeenCalled();
});

it('restores every close path when upload is not busy', () => {
  // Break caught: the busy lock remains stuck after the request settles.
  const onClose = vi.fn();
  const view = render(<AvatarCropDialog
    sourceUrl="blob:avatar"
    image={largeImage()}
    crop={{ x: 500, y: 250, width: 2000, height: 2000 }}
    busy={false}
    progress={0}
    onCropChange={vi.fn()}
    onConfirm={vi.fn()}
    onClose={onClose}
  />);

  expect(screen.getByRole('button', { name: '关闭' })).toBeEnabled();
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.mouseDown(view.container.querySelector('.modal-backdrop')!);
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(onClose).toHaveBeenCalledTimes(3);
});

it('announces exact progress and disables crop writes while uploading', () => {
  // Break caught: upload status is inaccessible or crop coordinates can mutate after the Blob is encoded.
  render(<AvatarCropDialog
    sourceUrl="blob:avatar"
    image={largeImage()}
    crop={{ x: 500, y: 250, width: 2000, height: 2000 }}
    busy
    progress={42}
    onCropChange={vi.fn()}
    onConfirm={vi.fn()}
    onClose={vi.fn()}
  />);

  expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  expect(screen.getByRole('status')).toHaveTextContent('正在上传 42%');
  expect(screen.getByRole('progressbar', { name: '头像上传进度' })).toHaveAttribute('value', '42');
  expect(screen.getByLabelText('水平位置')).toBeDisabled();
  expect(screen.getByLabelText('垂直位置')).toBeDisabled();
});

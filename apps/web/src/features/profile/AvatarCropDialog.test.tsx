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

it('routes Escape and the visible close button through upload cancellation', () => {
  // Break caught: Modal close paths bypassed the upload cleanup handler while busy.
  const onClose = vi.fn();
  const props = {
    sourceUrl: 'blob:avatar', image: largeImage(),
    crop: { x: 500, y: 250, width: 2000, height: 2000 },
    busy: true, progress: 40, onCropChange: vi.fn(), onConfirm: vi.fn(), onClose
  };
  const view = render(<AvatarCropDialog {...props} />);

  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledOnce();
  view.rerender(<AvatarCropDialog {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(onClose).toHaveBeenCalledTimes(2);
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

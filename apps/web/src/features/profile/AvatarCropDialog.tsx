import { useCallback } from 'react';
import { Button } from '../../components/Button.js';
import { Modal } from '../../components/Modal.js';

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function cropPreviewStyle(image: HTMLImageElement, crop: CropRect, viewportSize = 260) {
  const scale = viewportSize / crop.width;
  return {
    width: `${image.naturalWidth * scale}px`,
    height: `${image.naturalHeight * scale}px`,
    transform: `translate(${-crop.x * scale}px, ${-crop.y * scale}px)`
  };
}

export function AvatarCropDialog({ sourceUrl, image, crop, busy, progress, uploadFailed = false, onCropChange, onConfirm, onRetry, onReselect, onClose }: {
  sourceUrl: string;
  image: HTMLImageElement;
  crop: CropRect;
  busy: boolean;
  progress: number;
  uploadFailed?: boolean;
  onCropChange: (crop: CropRect) => void;
  onConfirm: () => void;
  onRetry?: () => void;
  onReselect?: () => void;
  onClose: () => void;
}) {
  const stableClose = useCallback(onClose, [onClose]);
  const maxX = Math.max(0, image.naturalWidth - crop.width);
  const maxY = Math.max(0, image.naturalHeight - crop.height);
  return <Modal title="裁剪头像" onClose={stableClose}><div className="modal-body">
    <div className="crop-preview"><img src={sourceUrl} alt="待裁剪头像" style={cropPreviewStyle(image, crop)} /></div>
    <label className="field" htmlFor="crop-x">水平位置<input id="crop-x" type="range" min="0" max={maxX} value={Math.min(crop.x, maxX)} disabled={busy || uploadFailed} onChange={(event) => onCropChange({ ...crop, x: Number(event.target.value) })} /></label>
    <label className="field" htmlFor="crop-y">垂直位置<input id="crop-y" type="range" min="0" max={maxY} value={Math.min(crop.y, maxY)} disabled={busy || uploadFailed} onChange={(event) => onCropChange({ ...crop, y: Number(event.target.value) })} /></label>
    {busy && <div className="avatar-upload-progress" role="status" aria-live="polite"><progress max={100} value={progress} aria-label="头像上传进度" /><span>正在上传 {progress}%</span></div>}
    {uploadFailed
      ? <div className="button-stack"><Button unsafe disabled={busy} onClick={onRetry}>重新上传</Button><Button unsafe variant="ghost" disabled={busy} onClick={onReselect}>重新选择照片</Button></div>
      : <div className="button-stack"><Button unsafe disabled={busy} onClick={onConfirm}>裁剪并上传</Button><Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button></div>}
  </div></Modal>;
}

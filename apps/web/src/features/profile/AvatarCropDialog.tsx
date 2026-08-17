import { useCallback } from 'react';
import { Button } from '../../components/Button.js';
import { Modal } from '../../components/Modal.js';

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function AvatarCropDialog({ sourceUrl, image, crop, busy, progress, onCropChange, onConfirm, onClose }: {
  sourceUrl: string;
  image: HTMLImageElement;
  crop: CropRect;
  busy: boolean;
  progress: number;
  onCropChange: (crop: CropRect) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const stableClose = useCallback(onClose, [onClose]);
  const maxX = Math.max(0, image.naturalWidth - crop.width);
  const maxY = Math.max(0, image.naturalHeight - crop.height);
  return <Modal title="裁剪头像" onClose={stableClose}><div className="modal-body">
    <div className="crop-preview"><img src={sourceUrl} alt="待裁剪头像" style={{
      width: `${image.naturalWidth}px`, height: `${image.naturalHeight}px`,
      transform: `translate(${-crop.x}px, ${-crop.y}px)`
    }} /></div>
    <label className="field" htmlFor="crop-x">水平位置<input id="crop-x" type="range" min="0" max={maxX} value={Math.min(crop.x, maxX)} onChange={(event) => onCropChange({ ...crop, x: Number(event.target.value) })} /></label>
    <label className="field" htmlFor="crop-y">垂直位置<input id="crop-y" type="range" min="0" max={maxY} value={Math.min(crop.y, maxY)} onChange={(event) => onCropChange({ ...crop, y: Number(event.target.value) })} /></label>
    {busy && <div className="upload-progress" role="status"><span>上传中 {progress}%</span><progress max="100" value={progress} /></div>}
    <div className="button-stack"><Button unsafe disabled={busy} onClick={onConfirm}>裁剪并上传</Button><Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button></div>
  </div></Modal>;
}

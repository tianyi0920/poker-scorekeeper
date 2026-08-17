import type { PresetAvatarId } from '@poker/contracts';
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { mutationMessage, scorekeeperApi, uploadAvatar, type AvatarMutationResponse, type PresetAvatarDto } from '../../api/resources.js';
import { Toast } from '../../components/Toast.js';
import { useOnlineStatus } from '../../hooks/useOnlineStatus.js';
import { AvatarCropDialog, type CropRect } from './AvatarCropDialog.js';

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface AvatarReference {
  kind: 'PRESET' | 'UPLOAD';
  value: string;
}

function avatarUrl(avatar: AvatarReference): string {
  return avatar.kind === 'PRESET' ? `/avatars/${avatar.value}.webp` : `/avatars/uploads/${avatar.value}`;
}

export async function cropAvatar(image: HTMLImageElement, crop: CropRect): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('AVATAR_CANVAS_UNAVAILABLE');
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, 512, 512);
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob === null ? reject(new Error('AVATAR_ENCODE_FAILED')) : resolve(blob),
    'image/webp',
    0.9
  ));
}

export function AvatarPicker({ currentAvatar, onChanged }: { currentAvatar: AvatarReference | null; onChanged: (avatar: AvatarReference) => void }) {
  const online = useOnlineStatus();
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const sourceUrlRef = useRef<string | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const [avatar, setAvatar] = useState(currentAvatar);
  const [presets, setPresets] = useState<PresetAvatarDto[]>([]);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setAvatar(currentAvatar), [currentAvatar?.kind, currentAvatar?.value]);
  useEffect(() => {
    let active = true;
    void scorekeeperApi.getPresetAvatars().then(({ presets: response }) => active && setPresets(response))
      .catch((reason) => active && setError(mutationMessage(reason, '预设头像加载失败')));
    return () => { active = false; };
  }, []);

  useEffect(() => () => {
    mountedRef.current = false;
    uploadAbortRef.current?.abort();
    if (sourceUrlRef.current !== null) URL.revokeObjectURL(sourceUrlRef.current);
    sourceUrlRef.current = null;
  }, []);

  const closeCrop = useCallback(() => {
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
    if (sourceUrlRef.current !== null) URL.revokeObjectURL(sourceUrlRef.current);
    sourceUrlRef.current = null;
    setSourceUrl(null);
    setImage(null);
    setCrop(null);
    setProgress(0);
    setBusy(false);
    if (inputRef.current !== null) inputRef.current.value = '';
  }, []);

  function applyServerAvatar(response: AvatarMutationResponse) {
    const next: AvatarReference = { kind: response.avatarKind, value: response.avatarValue };
    setAvatar(next);
    onChanged(next);
  }

  async function choosePreset(id: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await scorekeeperApi.selectPresetAvatar({ presetId: id as PresetAvatarId });
      applyServerAvatar(response);
    } catch (reason) {
      setError(mutationMessage(reason, '头像保存失败'));
    } finally {
      setBusy(false);
    }
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    setError(null);
    if (file.size > MAX_AVATAR_BYTES) {
      setError('图片不能超过 5 MiB');
      event.target.value = '';
      return;
    }
    if (!allowedTypes.has(file.type)) {
      setError('仅支持 JPG、PNG 或 WebP 图片');
      event.target.value = '';
      return;
    }
    const url = URL.createObjectURL(file);
    sourceUrlRef.current = url;
    const nextImage = new Image();
    nextImage.onload = () => {
      if (!mountedRef.current || sourceUrlRef.current !== url) {
        URL.revokeObjectURL(url);
        return;
      }
      const size = Math.min(nextImage.naturalWidth, nextImage.naturalHeight);
      setImage(nextImage);
      setSourceUrl(url);
      setCrop({
        x: Math.floor((nextImage.naturalWidth - size) / 2),
        y: Math.floor((nextImage.naturalHeight - size) / 2),
        width: size,
        height: size
      });
    };
    nextImage.onerror = () => {
      URL.revokeObjectURL(url);
      if (!mountedRef.current || sourceUrlRef.current !== url) return;
      sourceUrlRef.current = null;
      setError('图片无法读取，请换一张图片');
      event.target.value = '';
    };
    nextImage.src = url;
  }

  async function confirmUpload() {
    if (image === null || crop === null) return;
    setBusy(true);
    setProgress(0);
    setError(null);
    const controller = new AbortController();
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = controller;
    try {
      const blob = await cropAvatar(image, crop);
      if (blob.size > MAX_AVATAR_BYTES) throw new Error('AVATAR_TOO_LARGE');
      if (controller.signal.aborted) return;
      const response = await uploadAvatar(blob, (nextProgress) => {
        if (mountedRef.current && !controller.signal.aborted) setProgress(nextProgress);
      }, controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      applyServerAvatar(response);
      closeCrop();
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      if (!mountedRef.current) return;
      const message = reason instanceof Error && reason.message === 'AVATAR_ENCODE_FAILED'
        ? '头像编码失败，请换一张图片'
        : reason instanceof Error && reason.message === 'AVATAR_TOO_LARGE'
          ? '裁剪后的图片不能超过 5 MiB'
          : mutationMessage(reason, '头像上传失败，请稍后重试');
      setError(message);
    } finally {
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
      if (mountedRef.current) setBusy(false);
    }
  }

  return <div className="avatar-picker">
    {error !== null && <Toast tone="error" message={error} />}
    <div className="current-avatar">{avatar === null ? <span className="avatar-placeholder" aria-hidden="true">?</span> : <img src={avatarUrl(avatar)} alt="当前头像" />}<div><strong>{avatar === null ? '当前头像尚未载入' : '当前头像'}</strong><span>新头像仅在服务器保存成功后替换</span></div></div>
    <div className="preset-grid" aria-label="预设头像">{presets.map((preset, index) => <button key={preset.id} type="button" disabled={busy || !online} aria-label={`选择预设头像 ${String(index + 1).padStart(2, '0')}`} className={avatar?.kind === 'PRESET' && avatar.value === preset.id ? 'preset-avatar preset-avatar--active' : 'preset-avatar'} onClick={() => void choosePreset(preset.id)}><img src={preset.path} alt="" /></button>)}</div>
    <label className="upload-label" htmlFor="avatar-file">上传自定义头像<input ref={inputRef} id="avatar-file" aria-label="上传自定义头像" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || !online} onChange={chooseFile} /><span>JPG / PNG / WebP，最大 5 MiB</span></label>
    {image !== null && sourceUrl !== null && crop !== null && <AvatarCropDialog sourceUrl={sourceUrl} image={image} crop={crop} busy={busy} progress={progress} onCropChange={setCrop} onConfirm={() => void confirmUpload()} onClose={closeCrop} />}
  </div>;
}

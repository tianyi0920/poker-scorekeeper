import type { SelectablePresetAvatarId } from '@poker/contracts';
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

function sameAvatar(left: AvatarReference | null, right: AvatarReference | null): boolean {
  return left?.kind === right?.kind && left?.value === right?.value;
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
  const acceptedAvatarRef = useRef<AvatarReference | null>(null);
  const presetSaveVersionRef = useRef(0);
  const activePresetSaveRef = useRef<number | null>(null);
  const [savedAvatar, setSavedAvatar] = useState(currentAvatar);
  const [pendingPreset, setPendingPreset] = useState<string | null>(null);
  const [presets, setPresets] = useState<PresetAvatarDto[]>([]);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    presetSaveVersionRef.current += 1;
    if (activePresetSaveRef.current !== null) {
      activePresetSaveRef.current = null;
      setIsSaving(false);
    }
    setSavedAvatar(currentAvatar);
    setPendingPreset(null);
    setError(null);
    if (!sameAvatar(currentAvatar, acceptedAvatarRef.current)) {
      acceptedAvatarRef.current = null;
      setSuccess(null);
    }
  }, [currentAvatar?.kind, currentAvatar?.value]);
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
    setIsSaving(false);
    if (inputRef.current !== null) inputRef.current.value = '';
  }, []);

  function applyServerAvatar(response: AvatarMutationResponse) {
    const next: AvatarReference = { kind: response.avatarKind, value: response.avatarValue };
    acceptedAvatarRef.current = next;
    setSavedAvatar(next);
    setPendingPreset(null);
    setSuccess('头像已保存');
    onChanged(next);
  }

  const savedPreset = savedAvatar?.kind === 'PRESET' ? savedAvatar.value : null;
  const selectedPreset = pendingPreset ?? savedPreset;
  const hasPendingPreset = pendingPreset !== null && pendingPreset !== savedPreset;

  function choosePreset(id: string) {
    if (isSaving || !online) return;
    setPendingPreset(id === savedPreset ? null : id);
    setError(null);
    setSuccess(null);
  }

  function cancelPreset() {
    if (isSaving) return;
    setPendingPreset(null);
    setError(null);
  }

  async function savePreset() {
    if (!hasPendingPreset || pendingPreset === null || isSaving || !online) return;
    const saveVersion = ++presetSaveVersionRef.current;
    activePresetSaveRef.current = saveVersion;
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await scorekeeperApi.selectPresetAvatar({ presetId: pendingPreset as SelectablePresetAvatarId });
      if (activePresetSaveRef.current !== saveVersion) return;
      applyServerAvatar(response);
    } catch (reason) {
      if (activePresetSaveRef.current === saveVersion) setError(mutationMessage(reason, '头像保存失败'));
    } finally {
      if (activePresetSaveRef.current === saveVersion) {
        activePresetSaveRef.current = null;
        setIsSaving(false);
      }
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
    setIsSaving(true);
    setProgress(0);
    setError(null);
    setSuccess(null);
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
      if (mountedRef.current) setIsSaving(false);
    }
  }

  return <div className="avatar-picker">
    {error !== null && <Toast tone="error" message={error} />}
    {success !== null && <Toast tone="success" message={success} />}
    <div className="current-avatar">{savedAvatar === null ? <span className="avatar-placeholder" aria-hidden="true">?</span> : <img src={avatarUrl(savedAvatar)} alt="当前头像" />}<div><strong>{savedAvatar === null ? '当前头像尚未载入' : '当前头像'}</strong><span>新头像仅在服务器保存成功后替换</span></div></div>
    <div className="preset-grid" role="radiogroup" aria-label="默认头像">{presets.map((preset) => {
      const label = `头像 ${Number(preset.id.slice('preset-'.length))}`;
      const checked = selectedPreset === preset.id;
      return <label key={preset.id} className={checked ? 'preset-avatar preset-avatar--active' : 'preset-avatar'}>
        <input type="radio" name="preset-avatar" value={preset.id} checked={checked} disabled={isSaving || !online} onChange={() => choosePreset(preset.id)} />
        <img src={preset.path} alt="" />
        <span className="sr-only">{label}</span>
      </label>;
    })}</div>
    {hasPendingPreset && <div className="avatar-actions">
      <button className="button button--primary" type="button" disabled={isSaving || !online} onClick={() => void savePreset()}>保存头像</button>
      <button className="button button--secondary" type="button" disabled={isSaving} onClick={cancelPreset}>取消修改</button>
    </div>}
    {error !== null && hasPendingPreset && <button className="button button--secondary avatar-retry" type="button" disabled={isSaving || !online} onClick={() => void savePreset()}>重试保存</button>}
    <label className="upload-label" htmlFor="avatar-file">上传自定义头像<input ref={inputRef} id="avatar-file" aria-label="上传自定义头像" type="file" accept="image/jpeg,image/png,image/webp" disabled={isSaving || !online} onChange={chooseFile} /><span>JPG / PNG / WebP，最大 5 MiB</span></label>
    {image !== null && sourceUrl !== null && crop !== null && <AvatarCropDialog sourceUrl={sourceUrl} image={image} crop={crop} busy={isSaving} progress={progress} onCropChange={setCrop} onConfirm={() => void confirmUpload()} onClose={closeCrop} />}
  </div>;
}

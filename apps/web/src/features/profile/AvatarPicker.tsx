import type { SelectablePresetAvatarId } from '@poker/contracts';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
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
  const uploadVersionRef = useRef(0);
  const activeUploadRef = useRef<number | null>(null);
  const [savedAvatar, setSavedAvatar] = useState(currentAvatar);
  const [pendingPreset, setPendingPreset] = useState<string | null>(null);
  const [presets, setPresets] = useState<PresetAvatarDto[]>([]);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [croppedBlob, setCroppedBlob] = useState<Blob | null>(null);
  const [uploadFailed, setUploadFailed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useLayoutEffect(() => {
    presetSaveVersionRef.current += 1;
    uploadVersionRef.current += 1;
    setSavedAvatar(currentAvatar);
    setPendingPreset(null);
    setError(null);
    if (!sameAvatar(currentAvatar, acceptedAvatarRef.current)) {
      acceptedAvatarRef.current = null;
      setSuccess(null);
    }
  }, [currentAvatar?.kind, currentAvatar?.value]);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      presetSaveVersionRef.current += 1;
      uploadVersionRef.current += 1;
      activePresetSaveRef.current = null;
      activeUploadRef.current = null;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void scorekeeperApi.getPresetAvatars().then(({ presets: response }) => active && setPresets(response))
      .catch((reason) => active && setError(mutationMessage(reason, '预设头像加载失败')));
    return () => { active = false; };
  }, []);

  useEffect(() => () => {
    uploadAbortRef.current?.abort();
    if (sourceUrlRef.current !== null) URL.revokeObjectURL(sourceUrlRef.current);
    sourceUrlRef.current = null;
  }, []);

  const releaseSourceUrl = useCallback(() => {
    if (sourceUrlRef.current !== null) URL.revokeObjectURL(sourceUrlRef.current);
    sourceUrlRef.current = null;
  }, []);

  const closeCrop = useCallback(() => {
    uploadVersionRef.current += 1;
    activeUploadRef.current = null;
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
    releaseSourceUrl();
    setSourceUrl(null);
    setImage(null);
    setCrop(null);
    setCroppedBlob(null);
    setUploadFailed(false);
    setProgress(0);
    setIsSaving(false);
    setError(null);
    if (inputRef.current !== null) inputRef.current.value = '';
  }, [releaseSourceUrl]);

  function applyServerAvatar(response: AvatarMutationResponse) {
    const next: AvatarReference = { kind: response.avatarKind, value: response.avatarValue };
    acceptedAvatarRef.current = next;
    setSavedAvatar(next);
    setPendingPreset(null);
    setSuccess('头像已保存');
    onChanged(next);
  }

  function acceptUploadedAvatar(response: AvatarMutationResponse) {
    const next: AvatarReference = { kind: response.avatarKind, value: response.avatarValue };
    acceptedAvatarRef.current = next;
    setPendingPreset(null);
    setSuccess('头像已保存');
    onChanged(next);
  }

  const savedPreset = savedAvatar?.kind === 'PRESET' ? savedAvatar.value : null;
  const selectedPreset = pendingPreset ?? savedPreset;
  const hasPendingPreset = pendingPreset !== null && pendingPreset !== savedPreset;
  const isCurrentPresetSave = (saveVersion: number) => mountedRef.current
    && activePresetSaveRef.current === saveVersion
    && presetSaveVersionRef.current === saveVersion;

  function choosePreset(id: string) {
    if (isSaving || !online) return;
    setPendingPreset(id === savedPreset ? null : id);
    setUploadFailed(false);
    setError(null);
    setSuccess(null);
  }

  function cancelPreset() {
    if (isSaving) return;
    setPendingPreset(null);
    setError(null);
  }

  async function savePreset() {
    if (!hasPendingPreset || pendingPreset === null || isSaving || activePresetSaveRef.current !== null || !online) return;
    const saveVersion = ++presetSaveVersionRef.current;
    activePresetSaveRef.current = saveVersion;
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await scorekeeperApi.selectPresetAvatar({ presetId: pendingPreset as SelectablePresetAvatarId });
      if (!isCurrentPresetSave(saveVersion)) return;
      applyServerAvatar(response);
    } catch (reason) {
      if (isCurrentPresetSave(saveVersion)) setError(mutationMessage(reason, '头像保存失败'));
    } finally {
      if (mountedRef.current && activePresetSaveRef.current === saveVersion) {
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
    releaseSourceUrl();
    setSourceUrl(null);
    setImage(null);
    setCrop(null);
    setCroppedBlob(null);
    setUploadFailed(false);
    setProgress(0);
    const url = URL.createObjectURL(file);
    sourceUrlRef.current = url;
    const nextImage = new Image();
    nextImage.onload = () => {
      if (!mountedRef.current || sourceUrlRef.current !== url) {
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
      if (!mountedRef.current || sourceUrlRef.current !== url) return;
      releaseSourceUrl();
      setError('图片无法读取，请换一张图片');
      event.target.value = '';
    };
    nextImage.src = url;
  }

  const isCurrentUpload = (uploadVersion: number, controller: AbortController) => mountedRef.current
    && activeUploadRef.current === uploadVersion
    && uploadVersionRef.current === uploadVersion
    && !controller.signal.aborted;

  async function saveUpload(retainedBlob: Blob | null) {
    if (image === null || crop === null || isSaving || activeUploadRef.current !== null || !online) return;
    const uploadVersion = ++uploadVersionRef.current;
    activeUploadRef.current = uploadVersion;
    setIsSaving(true);
    setProgress(0);
    setError(null);
    setSuccess(null);
    setUploadFailed(false);
    const controller = new AbortController();
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = controller;
    try {
      const blob = retainedBlob ?? await cropAvatar(image, crop);
      if (blob.size > MAX_AVATAR_BYTES) throw new Error('AVATAR_TOO_LARGE');
      if (!isCurrentUpload(uploadVersion, controller)) return;
      setCroppedBlob(blob);
      const response = await uploadAvatar(blob, (nextProgress) => {
        if (isCurrentUpload(uploadVersion, controller)) setProgress(nextProgress);
      }, controller.signal);
      if (!isCurrentUpload(uploadVersion, controller)) return;
      acceptUploadedAvatar(response);
      closeCrop();
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      if (!isCurrentUpload(uploadVersion, controller)) return;
      const message = reason instanceof Error && reason.message === 'AVATAR_ENCODE_FAILED'
        ? '头像编码失败，请换一张图片'
        : reason instanceof Error && reason.message === 'AVATAR_TOO_LARGE'
          ? '裁剪后的图片不能超过 5 MiB'
          : '上传失败，请重试';
      setUploadFailed(message === '上传失败，请重试');
      setError(message);
    } finally {
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
      if (mountedRef.current && activeUploadRef.current === uploadVersion) {
        activeUploadRef.current = null;
        setIsSaving(false);
      }
    }
  }

  function openFilePicker() {
    if (isSaving || !online) return;
    if (inputRef.current !== null) {
      inputRef.current.value = '';
      inputRef.current.click();
    }
  }

  function reselectPhoto() {
    if (isSaving || !online) return;
    closeCrop();
    inputRef.current?.click();
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
    {error !== null && hasPendingPreset && !uploadFailed && <button className="button button--secondary avatar-retry" type="button" disabled={isSaving || !online} onClick={() => void savePreset()}>重试保存</button>}
    <div className="avatar-upload-picker">
      <button className="button button--secondary avatar-album-button" type="button" disabled={isSaving || !online} onClick={openFilePicker}>从相册选择</button>
      <input ref={inputRef} className="visually-hidden-file-input" id="avatar-file" aria-label="从相册选择文件" tabIndex={-1} type="file" accept="image/jpeg,image/png,image/webp" disabled={isSaving || !online} onChange={chooseFile} />
      <span>JPG / PNG / WebP，最大 5 MiB</span>
    </div>
    {image !== null && sourceUrl !== null && crop !== null && <AvatarCropDialog sourceUrl={sourceUrl} image={image} crop={crop} busy={isSaving} progress={progress} uploadFailed={uploadFailed} onCropChange={setCrop} onConfirm={() => void saveUpload(null)} onRetry={() => void saveUpload(croppedBlob)} onReselect={reselectPhoto} onClose={closeCrop} />}
  </div>;
}

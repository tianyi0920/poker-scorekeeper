import type { AvatarMutationResponse } from '@poker/contracts';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
import { mutationMessage, uploadAvatar } from '../../api/resources.js';
import { Toast } from '../../components/Toast.js';
import { UserAvatar } from '../../components/UserAvatar.js';
import { useOnlineStatus } from '../../hooks/useOnlineStatus.js';
import { AvatarCropDialog, type CropRect } from './AvatarCropDialog.js';

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface AvatarReference {
  kind: 'PRESET' | 'UPLOAD';
  value: string;
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

export function AvatarPicker({ currentAvatar, onChanged, nickname = '用户' }: {
  currentAvatar: AvatarReference | null;
  onChanged: (avatar: AvatarReference) => Promise<void> | void;
  nickname?: string;
}) {
  const online = useOnlineStatus();
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const sourceUrlRef = useRef<string | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const acceptedAvatarRef = useRef<AvatarReference | null>(null);
  const uploadVersionRef = useRef(0);
  const activeUploadRef = useRef<number | null>(null);
  const sessionSyncVersionRef = useRef(0);
  const [savedAvatar, setSavedAvatar] = useState(currentAvatar);
  const [pendingSessionSyncAvatar, setPendingSessionSyncAvatar] = useState<AvatarReference | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [croppedBlob, setCroppedBlob] = useState<Blob | null>(null);
  const [uploadFailed, setUploadFailed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSynchronizing, setIsSynchronizing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useLayoutEffect(() => {
    uploadVersionRef.current += 1;
    setSavedAvatar(currentAvatar);
    setError(null);
    if (!sameAvatar(currentAvatar, acceptedAvatarRef.current)) {
      acceptedAvatarRef.current = null;
      sessionSyncVersionRef.current += 1;
      setPendingSessionSyncAvatar(null);
      setIsSynchronizing(false);
      setSyncError(null);
      setSuccess(null);
    }
  }, [currentAvatar?.kind, currentAvatar?.value]);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      uploadVersionRef.current += 1;
      sessionSyncVersionRef.current += 1;
      activeUploadRef.current = null;
    };
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

  function acceptServerAvatar(response: AvatarMutationResponse): AvatarReference {
    const next: AvatarReference = { kind: response.avatarKind, value: response.avatarValue };
    acceptedAvatarRef.current = next;
    setSavedAvatar(next);
    setSuccess('头像已保存');
    return next;
  }

  const isCurrentSessionSync = (syncVersion: number, next: AvatarReference) => mountedRef.current
    && sessionSyncVersionRef.current === syncVersion
    && sameAvatar(acceptedAvatarRef.current, next);

  async function synchronizeAcceptedAvatar(next: AvatarReference): Promise<void> {
    const syncVersion = ++sessionSyncVersionRef.current;
    setIsSynchronizing(true);
    setSyncError(null);
    try {
      await onChanged(next);
      if (!isCurrentSessionSync(syncVersion, next)) return;
      setPendingSessionSyncAvatar(null);
    } catch {
      if (!isCurrentSessionSync(syncVersion, next)) return;
      setPendingSessionSyncAvatar(next);
      setSyncError('头像已保存，但页面状态同步失败');
    } finally {
      if (isCurrentSessionSync(syncVersion, next)) setIsSynchronizing(false);
    }
  }

  const hasPendingSessionSync = pendingSessionSyncAvatar !== null;
  const isAvatarWriteLocked = isSaving || hasPendingSessionSync;

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
    if (image === null || crop === null || isAvatarWriteLocked || activeUploadRef.current !== null || !online) return;
    const uploadVersion = ++uploadVersionRef.current;
    activeUploadRef.current = uploadVersion;
    setIsSaving(true);
    setProgress(0);
    setError(null);
    setSuccess(null);
    setUploadFailed(false);
    const controller = new AbortController();
    let uploadStarted = false;
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = controller;
    try {
      const blob = retainedBlob ?? await cropAvatar(image, crop);
      if (blob.size > MAX_AVATAR_BYTES) throw new Error('AVATAR_TOO_LARGE');
      if (!isCurrentUpload(uploadVersion, controller)) return;
      setCroppedBlob(blob);
      uploadStarted = true;
      const response = await uploadAvatar(blob, (nextProgress) => {
        if (isCurrentUpload(uploadVersion, controller)) setProgress(nextProgress);
      }, controller.signal);
      if (!isCurrentUpload(uploadVersion, controller)) return;
      const acceptedAvatar = acceptServerAvatar(response);
      await synchronizeAcceptedAvatar(acceptedAvatar);
      if (mountedRef.current && activeUploadRef.current === uploadVersion) closeCrop();
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      if (!isCurrentUpload(uploadVersion, controller)) return;
      const message = reason instanceof Error && reason.message === 'AVATAR_ENCODE_FAILED'
        ? '头像编码失败，请换一张图片'
        : reason instanceof Error && reason.message === 'AVATAR_TOO_LARGE'
          ? '裁剪后的图片不能超过 5 MiB'
          : mutationMessage(reason, '上传失败，请重试');
      setUploadFailed(uploadStarted);
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
    if (isAvatarWriteLocked || !online) return;
    if (inputRef.current !== null) {
      inputRef.current.value = '';
      inputRef.current.click();
    }
  }

  function reselectPhoto() {
    if (isAvatarWriteLocked || !online) return;
    closeCrop();
    inputRef.current?.click();
  }

  async function retrySessionSynchronization() {
    if (pendingSessionSyncAvatar === null || isSynchronizing || !online) return;
    await synchronizeAcceptedAvatar(pendingSessionSyncAvatar);
  }

  return <div className="avatar-picker">
    {error !== null && <Toast tone="error" message={error} />}
    {syncError !== null && <Toast tone="error" message={syncError} />}
    {success !== null && <Toast tone="success" message={success} />}
    <div className="current-avatar"><UserAvatar nickname={nickname} avatarKind={savedAvatar?.kind} avatarValue={savedAvatar?.value} label="当前头像" /><div><strong>{nickname}</strong><span>{savedAvatar?.kind === 'UPLOAD' ? '已使用上传照片' : '使用昵称首字作为头像'}</span></div></div>
    {hasPendingSessionSync && <button className="button button--secondary avatar-retry" type="button" disabled={isSynchronizing || !online} onClick={() => void retrySessionSynchronization()}>重试页面状态同步</button>}
    <div className="avatar-upload-picker">
      <button className="button button--secondary avatar-album-button" aria-label="从相册选择" type="button" disabled={isAvatarWriteLocked || !online} onClick={openFilePicker}>更换头像</button>
      <input ref={inputRef} className="visually-hidden-file-input" id="avatar-file" aria-label="从相册选择文件" tabIndex={-1} type="file" accept="image/jpeg,image/png,image/webp" disabled={isAvatarWriteLocked || !online} onChange={chooseFile} />
      <span>JPG / PNG / WebP，最大 5 MiB</span>
    </div>
    {image !== null && sourceUrl !== null && crop !== null && <AvatarCropDialog sourceUrl={sourceUrl} image={image} crop={crop} busy={isSaving} progress={progress} uploadFailed={uploadFailed} onCropChange={setCrop} onConfirm={() => void saveUpload(null)} onRetry={() => void saveUpload(croppedBlob)} onReselect={reselectPhoto} onClose={closeCrop} />}
  </div>;
}

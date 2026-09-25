/**
 * "Edit Image": drag to move, zoom with the slider or the mouse wheel, then
 * apply. Used for profile pictures, character pictures, server icons and
 * jukebox covers. Returns a square image file, or null if cancelled.
 */

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { openModal } from '../store/actions';
import { Icon, mdiImage, mdiRestore } from './icons';
import { Modal } from './layers';
import { toast } from './Toasts';
import { Button, Slider } from './ui';

export interface CropOptions {
  /** How the result will be shown: a circle (avatars, server icons) or a square (covers). */
  shape?: 'circle' | 'square';
  title?: string;
  /** Size of the square it produces, in pixels. */
  size?: number;
}

const MAX_ZOOM = 5;

/** Open the cropper for `file`. Resolves with the cropped file, or null if cancelled. */
export function cropImage(file: File, opts: CropOptions = {}): Promise<File | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (f: File | null) => {
      if (settled) return;
      settled = true;
      resolve(f);
    };
    openModal((close) => (
      <CropModal
        file={file}
        opts={opts}
        onDone={(f) => {
          finish(f);
          close();
        }}
        onCancel={() => {
          finish(null);
          close();
        }}
      />
    ));
  });
}

function CropModal({ file, opts, onDone, onCancel }: { file: File; opts: CropOptions; onDone: (f: File) => void; onCancel: () => void }) {
  const shape = opts.shape ?? 'circle';
  const outSize = opts.size ?? 512;
  const [url] = useState(() => URL.createObjectURL(file));
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [box, setBox] = useState(320); // viewport size in CSS pixels
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 }); // image centre relative to the viewport centre
  const [busy, setBusy] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null);
  const animated = file.type === 'image/gif';

  useEffect(() => {
    const el = new Image();
    el.onload = () => setImg(el);
    el.onerror = () => setFailed(true);
    el.src = url;
    return () => URL.revokeObjectURL(url);
  }, [url]);

  useLayoutEffect(() => {
    const measure = () => setBox(Math.min(320, Math.max(200, window.innerWidth - 96)));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Scale that makes the image just cover the viewport at zoom 1.
  const base = img ? box / Math.min(img.naturalWidth, img.naturalHeight) : 1;
  const scale = base * zoom;
  const width = img ? img.naturalWidth * scale : box;
  const height = img ? img.naturalHeight * scale : box;

  const clamp = (o: { x: number; y: number }, w = width, h = height) => ({
    x: Math.max(-(w - box) / 2, Math.min((w - box) / 2, o.x)),
    y: Math.max(-(h - box) / 2, Math.min((h - box) / 2, o.y)),
  });

  /** Zoom to `next`, keeping the point `at` (relative to the viewport centre) still. */
  const zoomTo = (next: number, at = { x: 0, y: 0 }) => {
    if (!img) return;
    const z = Math.max(1, Math.min(MAX_ZOOM, next));
    const ratio = z / zoom;
    const w = img.naturalWidth * base * z;
    const h = img.naturalHeight * base * z;
    setOffset((o) => clamp({ x: at.x - (at.x - o.x) * ratio, y: at.y - (at.y - o.y) * ratio }, w, h));
    setZoom(z);
  };

  // Re-clamp if the viewport size changes.
  useEffect(() => {
    setOffset((o) => clamp(o));
  }, [box, img]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (e: PointerEvent) => {
    if (!img) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    setOffset(clamp({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }));
  };
  const onPointerUp = (e: PointerEvent) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };
  const onWheel = (e: WheelEvent) => {
    if (!img || !viewport.current) return;
    const r = viewport.current.getBoundingClientRect();
    const at = { x: e.clientX - (r.left + r.width / 2), y: e.clientY - (r.top + r.height / 2) };
    zoomTo(zoom * Math.exp(-e.deltaY * 0.0015), at);
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 20 : 5;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const m = moves[e.key];
    if (m) {
      e.preventDefault();
      setOffset((o) => clamp({ x: o.x + m[0], y: o.y + m[1] }));
    } else if (e.key === '+' || e.key === '=') zoomTo(zoom * 1.1);
    else if (e.key === '-') zoomTo(zoom / 1.1);
  };

  const apply = async () => {
    if (!img) return;
    setBusy(true);
    try {
      const left = (box - width) / 2 + offset.x;
      const top = (box - height) / 2 + offset.y;
      const sx = -left / scale;
      const sy = -top / scale;
      const side = box / scale;
      // Don't blow a small picture up past its own detail.
      const size = Math.max(64, Math.min(outSize, Math.round(side)));
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const g = canvas.getContext('2d')!;
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      const jpeg = file.type === 'image/jpeg';
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, jpeg ? 'image/jpeg' : 'image/png', 0.92));
      if (!blob) throw new Error('encode');
      const name = file.name.replace(/\.[^.]+$/, '') + (jpeg ? '.jpg' : '.png');
      onDone(new File([blob], name, { type: blob.type }));
    } catch {
      toast("Couldn't crop that picture. Try another one.");
      setBusy(false);
    }
  };

  const left = (box - width) / 2 + offset.x;
  const top = (box - height) / 2 + offset.y;

  return (
    <Modal
      title={opts.title ?? 'Edit Image'}
      onClose={onCancel}
      className="crop-modal"
      footer={
        <>
          {animated && (
            <Button look="link" onClick={() => onDone(file)} className="crop-skip">
              Keep it animated
            </Button>
          )}
          <Button look="link" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={apply} loading={busy} disabled={!img}>
            Apply
          </Button>
        </>
      }
    >
      <div
        ref={viewport}
        className={`crop-viewport ${shape}`}
        style={{ width: box, height: box }}
        tabIndex={0}
        role="application"
        aria-label="Drag to move the picture, scroll or use the slider to zoom"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onKeyDown={onKey}
        onDoubleClick={() => {
          setZoom(1);
          setOffset({ x: 0, y: 0 });
        }}
      >
        {img && <img src={url} alt="" draggable={false} style={{ width, height, transform: `translate(${left}px, ${top}px)` }} />}
        {!img && !failed && <div className="crop-loading">Loading…</div>}
        {failed && <div className="crop-loading">That file isn't a picture Tavern can read.</div>}
        <div className="crop-mask" />
      </div>
      <div className="crop-zoom">
        <Icon path={mdiImage} size={16} />
        <Slider value={zoom} min={1} max={MAX_ZOOM} step={0.01} onChange={(v) => zoomTo(v)} label="Zoom" className="crop-slider" />
        <Icon path={mdiImage} size={24} />
        <button
          type="button"
          className="crop-reset"
          onClick={() => {
            setZoom(1);
            setOffset({ x: 0, y: 0 });
          }}
          aria-label="Reset"
          title="Reset"
        >
          <Icon path={mdiRestore} size={18} />
        </button>
      </div>
      <p className="crop-hint">
        Drag to move, scroll or use the slider to zoom.
        {animated && ' Cropping makes a GIF still; keep it animated to use it as it is.'}
      </p>
    </Modal>
  );
}

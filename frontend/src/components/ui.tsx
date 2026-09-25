/* Small building blocks shared across the app. */
import { useId, type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import type { Presence } from '../store/types';
import { Icon, mdiCheck, mdiClose } from './icons';

// ---------------------------------------------------------------------------
// Avatar with a status "cutout", like Discord's
// ---------------------------------------------------------------------------

function statusGeometry(size: number) {
  const dot = size <= 24 ? 8 : size <= 32 ? 10 : size <= 40 ? 12 : size <= 56 ? 14 : size <= 80 ? 16 : 20;
  const ring = size <= 40 ? 3 : size <= 80 ? 5 : 6;
  return { dot, ring, center: size - dot / 2 };
}

export function Avatar({
  src,
  size = 40,
  status,
  className,
  style,
  alt = '',
  onClick,
  typing,
}: {
  src: string;
  size?: number;
  status?: Presence | null;
  className?: string;
  style?: CSSProperties;
  alt?: string;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  typing?: boolean;
}) {
  const g = statusGeometry(size);
  const cut = g.dot / 2 + g.ring;
  const mask = status ? `radial-gradient(circle at ${g.center}px ${g.center}px, transparent ${cut - 0.5}px, #000 ${cut}px)` : undefined;
  return (
    <div
      className={`avatar ${onClick ? 'clickable' : ''} ${className ?? ''}`}
      style={{ width: size, height: size, ...style }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
    >
      <img src={src} alt={alt} draggable={false} style={{ width: size, height: size, WebkitMaskImage: mask, maskImage: mask }} loading="lazy" />
      {status && (
        <span
          className={`status status-${status} ${typing ? 'status-typing' : ''}`}
          style={{ width: g.dot, height: g.dot, left: g.center - g.dot / 2, top: g.center - g.dot / 2 }}
          aria-label={status}
        />
      )}
    </div>
  );
}

export function StatusDot({ status, size = 10 }: { status: Presence | 'invisible'; size?: number }) {
  const s = status === 'invisible' ? 'offline' : status;
  return <span className={`status status-inline status-${s}`} style={{ width: size, height: size }} />;
}

export const STATUS_LABEL: Record<string, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do Not Disturb',
  invisible: 'Invisible',
  offline: 'Offline',
};

// ---------------------------------------------------------------------------
// Buttons & form controls
// ---------------------------------------------------------------------------

type Look = 'brand' | 'secondary' | 'danger' | 'green' | 'link' | 'outline' | 'gold';

export function Button({
  look = 'brand',
  size = 'medium',
  loading,
  className,
  children,
  grow,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { look?: Look; size?: 'small' | 'medium' | 'large'; loading?: boolean; grow?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      className={`btn btn-${look} btn-${size} ${grow ? 'btn-grow' : ''} ${loading ? 'btn-loading' : ''} ${className ?? ''}`}
    >
      <span className="btn-contents">{children}</span>
      {loading && (
        <span className="btn-spinner" aria-label="Loading">
          <span />
          <span />
          <span />
        </span>
      )}
    </button>
  );
}

export function Field({
  label,
  error,
  required,
  hint,
  children,
  htmlFor,
  className,
}: {
  label: ReactNode;
  error?: string;
  required?: boolean;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <div className={`field ${className ?? ''}`}>
      <label className={`field-label ${error ? 'error' : ''}`} htmlFor={htmlFor}>
        {label}
        {required && !error && <span className="required">*</span>}
        {error && <span className="field-error"> - {error}</span>}
      </label>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={`input ${className ?? ''}`} />;
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={`input textarea ${className ?? ''}`} />;
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob">
        <Icon path={checked ? mdiCheck : mdiClose} size={14} />
      </span>
    </button>
  );
}

export function SwitchRow({
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  title: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={`switch-row ${disabled ? 'disabled' : ''}`}>
      <div className="switch-row-top">
        <label htmlFor={id} className="switch-row-title">
          {title}
        </label>
        <span id={id}>
          <Switch checked={checked} onChange={onChange} disabled={disabled} label={typeof title === 'string' ? title : undefined} />
        </span>
      </div>
      {description && <div className="switch-row-desc">{description}</div>}
    </div>
  );
}

export function Divider({ style }: { style?: CSSProperties }) {
  return <div className="divider" style={style} />;
}

export function Spinner({ size = 32 }: { size?: number }) {
  return (
    <span className="spinner" style={{ width: size, height: size }} aria-label="Loading">
      <span className="spinner-cube" />
      <span className="spinner-cube" />
    </span>
  );
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={`select ${className ?? ''}`}>
      <select
        value={String(value)}
        onChange={(e) => {
          const opt = options.find((o) => String(o.value) === e.target.value);
          if (opt) onChange(opt.value);
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A range slider whose filled part tracks the value (styled in theme.css). */
export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  onCommit,
  disabled,
  label,
  className,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  disabled?: boolean;
  label: string;
  className?: string;
}) {
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      className={`slider ${className ?? ''}`}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={label}
      style={{ '--fill': `${pct}%` } as CSSProperties}
      onChange={(e) => onChange(Number(e.target.value))}
      onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
      onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
    />
  );
}

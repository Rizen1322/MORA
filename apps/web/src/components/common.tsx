import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MusicNotesSimple } from '@phosphor-icons/react';
import { seedColors } from '../lib/color.ts';
import { desktop } from '../lib/desktop.ts';
import { useApp } from '../store/app.ts';

export function Cover({ url, seed, alt = '', className = '', round = false, size }: { url: string | null | undefined; seed: string; alt?: string; className?: string; round?: boolean; size?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  // YouTube Music artwork (googleusercontent) refuses requests that carry a foreign Referer.
  if (url && !failed) {
    return <img className={`cover ${round ? 'round' : ''} ${className}`} src={url} alt={alt} referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => setFailed(true)} style={size ? { width: size, height: size } : undefined} />;
  }
  const [a, b] = seedColors(seed);
  return (
    <div className={`cover cover-fallback ${round ? 'round' : ''} ${className}`} role="img" aria-label={alt || 'Нет обложки'} style={{ '--fb1': a, '--fb2': b, ...(size ? { width: size, height: size } : {}) } as CSSProperties}>
      <MusicNotesSimple size={size ? Math.max(14, size * 0.35) : 40} weight="duotone" />
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)} />;
}

export function useDialogFocus(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    const selector = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';
    dialog?.querySelector<HTMLElement>(selector)?.focus();
    const onKey = (event: KeyboardEvent) => {
      // A nested queue or menu owns its own keyboard interaction.
      if (document.querySelector('.queue-panel')?.contains(document.activeElement) && !dialog?.contains(document.activeElement)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === 'Tab' && dialog) {
        const items = Array.from(dialog.querySelectorAll<HTMLElement>(selector)).filter((item) => item.getClientRects().length > 0);
        const first = items[0];
        const last = items[items.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    dialog?.addEventListener('keydown', onKey);
    return () => {
      dialog?.removeEventListener('keydown', onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, [ref]);
}

export function Modal({ title, children, onClose, actions }: { title: string; children: ReactNode; onClose: () => void; actions?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose);
  return createPortal(
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h2>{title}</h2>
        {children}
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>, document.body
  );
}

/** Text prompt modal (rename, create). */
export function PromptModal({ title, label, initial = '', confirm, onSubmit, onClose }: { title: string; label: string; initial?: string; confirm: string; onSubmit: (v: string) => void | Promise<void>; onClose: () => void }) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!v.trim()) return;
    setBusy(true);
    try {
      await onSubmit(v.trim());
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-primary" disabled={!v.trim() || busy} onClick={submit}>
            {confirm}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="prompt-input">{label}</label>
        <input id="prompt-input" className="input" value={v} maxLength={120} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
    </Modal>
  );
}

export function ConfirmModal({ title, text, confirm, danger, onConfirm, onClose }: { title: string; text: string; confirm: string; danger?: boolean; onConfirm: () => void | Promise<void>; onClose: () => void }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Отмена
          </button>
          <button
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={async () => {
              await onConfirm();
              onClose();
            }}
          >
            {confirm}
          </button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>
        {text}
      </p>
    </Modal>
  );
}

/** Lightweight context menu anchored to a point. */
export function Menu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ x: Math.min(x, innerWidth - r.width - 8), y: Math.min(y, innerHeight - r.height - 8) });
      el.querySelector<HTMLElement>('button, a')?.focus();
    }
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const t = setTimeout(() => {
      window.addEventListener('mousedown', close);
      window.addEventListener('keydown', close);
      window.addEventListener('resize', onClose);
    });
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
      window.removeEventListener('resize', onClose);
    };
  }, [x, y, onClose]);
  const onKey = (e: React.KeyboardEvent) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button, a') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    }
  };
  return (
    <div className="menu" role="menu" ref={ref} style={{ left: pos.x, top: pos.y }} onKeyDown={onKey} onClick={onClose}>
      {children}
    </div>
  );
}

export function useReducedMotion(): boolean {
  const preference=useApp(s=>s.settings?.ui.motion??(desktop?'full':'system'));
  const [r, setR] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  // iPhone app: a hot phone or Low Power Mode (html[data-power=saver], apps/mobile) stills the canvases
  const saver = () => document.documentElement.dataset.power === 'saver';
  const [s, setS] = useState(saver);
  useEffect(() => {
    const m = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setR(m.matches);
    const onPower = () => setS(saver());
    m.addEventListener('change', on);
    window.addEventListener('mora-power', onPower);
    return () => { m.removeEventListener('change', on); window.removeEventListener('mora-power', onPower); };
  }, []);
  return s||preference==='reduced'||preference==='system'&&r;
}

export function Equalizer({ playing }: { playing: boolean }) {
  return (
    <span className={`equalizer ${playing ? '' : 'paused'}`} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

/**
 * Presence-style text swap (the AnimatePresence pattern from Motion, done in CSS):
 * when `k` changes the old content blurs up and out while the new one rises in.
 * Both share one grid cell, so layout never jumps.
 */
export function Swap({ k, children, className = '' }: { k: string; children: ReactNode; className?: string }) {
  const [state, setState] = useState<{ k: string; leaving: { k: string; node: ReactNode } | null }>({ k, leaving: null });
  const last = useRef({ k, node: children });
  if (state.k !== k) setState({ k, leaving: last.current.k === k ? null : last.current });
  last.current = { k, node: children };
  const leaving = state.leaving;
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setState((s) => ({ ...s, leaving: null })), 420);
    return () => clearTimeout(t);
  }, [leaving]);
  return (
    <span className={`swap ${className}`}>
      {leaving && <span key={`out-${leaving.k}`} className="swap-out" aria-hidden="true">{leaving.node}</span>}
      <span key={k} className="swap-in">{children}</span>
    </span>
  );
}

/** Words rise one after another (split-text stagger) for display titles. */
export function SplitWords({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\s+)/).map((w, i) => (/^\s+$/.test(w) ? w : <span key={i} className="split-w" style={{ '--i': i / 2 } as CSSProperties}>{w}</span>))}
    </>
  );
}

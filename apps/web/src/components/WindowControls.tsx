import { X } from '@phosphor-icons/react';
import { desktop } from '../lib/desktop.ts';

export function WindowControls() {
  if (!desktop?.windowCommand) return null;
  return <div className="window-controls" aria-label="Управление окном">
    <button aria-label="Свернуть окно" title="Свернуть" onClick={() => void desktop?.windowCommand?.('minimize')}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6.5h10" /></svg></button>
    <button aria-label="Развернуть или восстановить окно" title="Развернуть / восстановить" onClick={() => void desktop?.windowCommand?.('maximize')}><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" /></svg></button>
    <button className="window-close" aria-label="Закрыть окно" title="Закрыть" onClick={() => void desktop?.windowCommand?.('close')}><X size={14} /></button>
  </div>;
}


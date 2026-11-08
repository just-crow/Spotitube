import { useEffect, useState } from 'react';
import { desktopAPI } from '../lib/desktop';

type UpdateState = { status: string; version?: string; availableVersion?: string; percent?: number; transferred?: number; total?: number; error?: string };
export function DesktopUpdates({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  useEffect(() => {
    const unsubscribe = desktopAPI?.onUpdate?.(setState);
    void desktopAPI?.invoke('updateState').then(setState).catch(() => setState({ status: 'error', error: 'Could not read update status.' }));
    return unsubscribe;
  }, []);
  const act = (method: string) => { void desktopAPI?.invoke(method).then(value => { if (value && typeof value === 'object') setState(value); }).catch(() => setState({ ...state, status: 'error', error: 'The update could not finish. Please try again.' })); };
  if (compact) return state.status === 'ready' ? <button className="secondary" onClick={() => act('installUpdate')}>Update ready · Restart</button> : null;
  return <div className="desktop-updates">
    <p>Installed version {state.version || '…'}</p>
    <p role="status">{state.status === 'checking' ? 'Checking for updates…'
      : state.status === 'downloading' ? `Downloading ${state.availableVersion} · ${Math.floor(state.percent || 0)}%`
      : state.status === 'ready' ? `Version ${state.availableVersion} is ready to install.`
      : state.status === 'up-to-date' ? 'You have the latest version.'
      : state.status === 'error' ? state.error
      : state.status === 'unsupported' ? 'Updates are available in the installed Windows app.' : 'Automatic updates are enabled.'}</p>
    {state.status === 'downloading' && <><progress aria-label="Update download progress" max={100} value={state.percent || 0} /><p>{((state.transferred || 0) / 1048576).toFixed(1)} / {((state.total || 0) / 1048576).toFixed(1)} MB</p></>}
    <p>Updates download automatically and install when you close Spotitube. Your library and downloaded songs stay on this computer.</p>
    {state.status === 'ready' ? <button className="primary" onClick={() => act('installUpdate')}>Restart and install</button>
      : <button className="primary" disabled={['checking', 'downloading', 'unsupported'].includes(state.status)} onClick={() => act('checkUpdates')}>{state.status === 'error' ? 'Retry update' : 'Check for updates'}</button>}
  </div>;
}

import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, LoaderCircle, LogOut, RefreshCw } from 'lucide-react';
import { api, errorMessage } from './api';
import QrCode from './QrCode';

export type DeviceSignInStatus = {
  status: 'none' | 'pending' | 'authorized' | 'denied' | 'expired';
  userCode?: string;
  verificationUrl?: string;
  expiresAt?: string;
  interval?: number;
};

/** Google's device-code sign-in for YouTube: the code is entered on a phone, nothing is typed on this screen. */
export default function YouTubeDeviceSignIn({ connectionId, signedIn, onChanged }: {
  connectionId: string;
  signedIn: boolean;
  onChanged: () => Promise<void>;
}) {
  const [state, setState] = useState<DeviceSignInStatus>({ status: signedIn ? 'authorized' : 'none' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A code requested earlier (before leaving this screen, or on another screen) is still being
  // polled by the server; show it again instead of asking Google for a new one.
  useEffect(() => {
    if (signedIn) return;
    let dead = false;
    api<DeviceSignInStatus>(`/youtube/${encodeURIComponent(connectionId)}/signin/status`)
      .then(next => { if (!dead && next.status === 'pending' && next.userCode) setState(next); })
      .catch(() => {});
    return () => { dead = true; };
  }, [connectionId, signedIn]);
  useEffect(() => {
    if (state.status !== 'pending') return;
    let dead = false;
    const tick = async () => {
      try {
        const next = await api<DeviceSignInStatus>(`/youtube/${encodeURIComponent(connectionId)}/signin/status`);
        if (dead) return;
        setState(next);
        if (next.status === 'authorized') await onChanged();
      } catch (e) {
        if (!dead) { setError(errorMessage(e)); setState({ status: 'none' }); }
      }
    };
    const id = window.setInterval(() => void tick(), Math.max(3, state.interval || 5) * 1000);
    return () => { dead = true; window.clearInterval(id); };
  }, [state.status, state.interval, connectionId, onChanged]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  const start = () => run(async () => { setState(await api<DeviceSignInStatus>(`/youtube/${encodeURIComponent(connectionId)}/signin/start`, {})); });
  const signOut = () => run(async () => { await api(`/youtube/${encodeURIComponent(connectionId)}/signout`, {}); setState({ status: 'none' }); await onChanged(); });
  return (
    <div className="plex-signin youtube-device-signin" aria-live="polite">
      {state.status === 'authorized' ? (
        <>
          <p className="youtube-device-done"><Check size={18} /> Signed in with Google. Your Home feed, subscriptions and history are available in YouTube.</p>
          <button type="button" className="button ghost full" disabled={busy} onClick={() => void signOut()}><LogOut size={17} /> Sign out of Google</button>
        </>
      ) : state.status === 'pending' && state.userCode ? (
        <>
          <p>On your phone, open <strong>{state.verificationUrl?.replace(/^https?:\/\//, '') || 'google.com/device'}</strong> and enter this code:</p>
          <div className="pair-code">{state.userCode}</div>
          <QrCode value={state.verificationUrl || 'https://www.google.com/device'} label="Scan to open google.com/device" />
          <a className="button primary full" href={state.verificationUrl || 'https://www.google.com/device'} target="_blank" rel="noopener noreferrer">Open google.com/device <ArrowUpRight size={17} /></a>
          <p className="form-help"><LoaderCircle className="spin" size={14} /> Waiting for Google… this screen updates by itself once you approve.</p>
          <button type="button" className="text-button" disabled={busy} onClick={() => void run(async () => { await api(`/youtube/${encodeURIComponent(connectionId)}/signin/cancel`, {}); setState({ status: 'none' }); })}>Cancel</button>
        </>
      ) : (
        <>
          <p>{state.status === 'denied' ? 'Google reported that access was denied. Start again to retry.' : state.status === 'expired' ? 'The code expired before it was entered. Start again for a new code.' : 'Sign in with your Google account to see your real Home feed, subscriptions, playlists and watch history. You enter a short code on your phone; nothing is typed on this screen.'}</p>
          <button type="button" className="button primary full" disabled={busy} onClick={() => void start()}>
            {busy ? <LoaderCircle className="spin" size={18} /> : state.status === 'none' ? <ArrowUpRight size={17} /> : <RefreshCw size={17} />} Sign in with Google on this screen
          </button>
        </>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

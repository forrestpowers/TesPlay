import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { api, ApiError, errorMessage } from './api';
import { YouTubeLogo } from './components';
import QrCode from './QrCode';
import type { DeviceSignInStatus } from './YouTubeDeviceSignIn';
import type { Connection } from './types';

type PageStatus = Omit<DeviceSignInStatus, 'status'> & { status: DeviceSignInStatus['status'] | 'starting' };

/**
 * Full-screen "Sign in with your phone" page for the YouTube hub: asks the server
 * for a Google device code as soon as it opens, shows the code with a QR that opens
 * google.com/device, and polls until the account is approved. Nothing is typed here.
 */
export default function YouTubeSignIn({ connection, canManage, onSignedIn, onCreateConnection }: {
  connection?: Connection;
  canManage: boolean;
  onSignedIn: () => Promise<void>;
  onCreateConnection: () => Promise<Connection>;
}) {
  const [state, setState] = useState<PageStatus>({ status: 'starting' });
  const [error, setError] = useState('');
  const [connectionId, setConnectionId] = useState(connection?.id || '');
  const [attempt, setAttempt] = useState(0);
  // The connection id lives in a ref so creating one mid-flight does not restart (and cancel) the request for a code.
  const idRef = useRef(connection?.id || '');
  useEffect(() => { if (connection?.id) { idRef.current = connection.id; setConnectionId(connection.id); } }, [connection?.id]);
  useEffect(() => {
    if (!canManage) return;
    let dead = false;
    (async () => {
      try {
        let id = idRef.current;
        if (!id) { const created = await onCreateConnection(); id = created.id; idRef.current = id; if (!dead) setConnectionId(id); }
        const path = `/youtube/${encodeURIComponent(id)}/signin`;
        const current = await api<DeviceSignInStatus>(`${path}/status`).catch(() => null);
        const next = current?.status === 'pending' && current.userCode ? current : await api<DeviceSignInStatus>(`${path}/start`, {});
        if (!dead) { setError(''); setState(next); }
      } catch (e) {
        if (!dead) { setError(errorMessage(e)); setState({ status: 'none' }); }
      }
    })();
    return () => { dead = true; };
  }, [attempt, canManage, onCreateConnection]);
  useEffect(() => {
    if (state.status !== 'pending' || !connectionId) return;
    let dead = false;
    const tick = async () => {
      try {
        const next = await api<DeviceSignInStatus>(`/youtube/${encodeURIComponent(connectionId)}/signin/status`);
        if (dead) return;
        setState(next);
        if (next.status === 'authorized') await onSignedIn();
      } catch (e) {
        if (!dead) { setError(e instanceof ApiError && e.status === 403 ? 'Only the server owner can sign in here.' : errorMessage(e)); setState({ status: 'none' }); }
      }
    };
    const id = window.setInterval(() => void tick(), Math.max(3, state.interval || 5) * 1000);
    return () => { dead = true; window.clearInterval(id); };
  }, [state.status, state.interval, connectionId, onSignedIn]);
  const code = state.userCode || '';
  const verification = state.verificationUrl || 'https://www.google.com/device';
  const link = code ? `${verification}${verification.includes('?') ? '&' : '?'}user_code=${encodeURIComponent(code)}` : verification;
  const host = verification.replace(/^https?:\/\/(www\.)?/, '');
  if (!canManage) return (
    <section className="youtube-signin" aria-label="YouTube sign-in">
      <div className="youtube-signin-copy"><span className="youtube-signin-brand"><YouTubeLogo /> YouTube</span><h1>Ask the server owner to sign in</h1><p>Google sign-in for YouTube is set up once by the owner of this TesPlay server. After that, Home, subscriptions and history appear here for everyone the owner shares it with.</p></div>
    </section>
  );
  return (
    <section className="youtube-signin" aria-label="YouTube sign-in" aria-live="polite">
      <div className="youtube-signin-copy">
        <span className="youtube-signin-brand"><YouTubeLogo /> YouTube</span>
        <h1>Sign in with your phone</h1>
        <ol className="youtube-signin-steps">
          <li><span>1</span><p>Scan the code with your phone’s camera, or go to <strong>{host}</strong></p></li>
          <li><span>2</span><p>Enter the code <strong className="youtube-signin-inline-code">{code || '…'}</strong></p></li>
          <li><span>3</span><p>Choose your Google account and tap <strong>Allow</strong></p></li>
        </ol>
        {state.status === 'authorized' && <p className="youtube-signin-status">Signed in. Loading your YouTube…</p>}
        {state.status === 'pending' && <p className="youtube-signin-status"><LoaderCircle className="spin" size={16} /> Waiting for Google. This screen updates by itself once you tap Allow.</p>}
        {state.status === 'starting' && <p className="youtube-signin-status"><LoaderCircle className="spin" size={16} /> Getting a code from Google…</p>}
        {(state.status === 'denied' || state.status === 'expired' || state.status === 'none') && (
          <p className="youtube-signin-status">
            {state.status === 'denied' ? 'Google reported that access was denied.' : state.status === 'expired' ? 'That code expired.' : ''}
            {error && <span className="form-error" role="alert">{error}</span>}
            <button type="button" className="button primary" onClick={() => setAttempt(n => n + 1)}><RefreshCw size={17} /> Get a new code</button>
          </p>
        )}
      </div>
      <div className="youtube-signin-card">
        {code ? <QrCode value={link} label={`Scan to open ${host} with code ${code}`} size={320} /> : <div className="youtube-signin-qr-placeholder"><LoaderCircle className="spin" size={28} /></div>}
        <div className="youtube-signin-code">{code || ' '}</div>
      </div>
    </section>
  );
}

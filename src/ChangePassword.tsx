import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { api, errorMessage } from './api';

/** Settings → Account: change this account's own password, owner included. */
export default function ChangePassword({ onToast }: { onToast: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const close = () => { setOpen(false); setCurrent(''); setNext(''); setConfirm(''); setError(''); };
  if (!open)
    return <div className="dashboard-setting"><span><strong>Password</strong><small>Change the password you use to sign in. Other devices are signed out.</small></span><button className="button ghost small" onClick={() => setOpen(true)}><KeyRound size={16} />Change password</button></div>;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (next.length < 12) return setError('Use a new password of at least 12 characters.');
    if (next !== confirm) return setError('The new passwords do not match.');
    setSaving(true);
    try {
      const result = await api<{ ok: boolean; signedOut: number }>('/account/password', { currentPassword: current, newPassword: next }, 'POST');
      close();
      onToast(result.signedOut ? `Password changed. ${result.signedOut} other ${result.signedOut === 1 ? 'device was' : 'devices were'} signed out.` : 'Password changed.');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };
  return <form className="account-form change-password" onSubmit={submit} aria-label="Change password">
    <strong>Change password</strong>
    <label>Current password<input type="password" required autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} /></label>
    <label>New password<input type="password" required minLength={12} maxLength={256} autoComplete="new-password" placeholder="At least 12 characters" value={next} onChange={e => setNext(e.target.value)} /></label>
    <label>Confirm new password<input type="password" required minLength={12} maxLength={256} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} /></label>
    <p className="form-help">This device stays signed in. Other browsers and screens need the new password.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="change-password-actions">
      <button className="button primary small" disabled={saving}>{saving ? 'Saving…' : 'Change password'}</button>
      <button type="button" className="button ghost small" disabled={saving} onClick={close}>Cancel</button>
    </div>
  </form>;
}

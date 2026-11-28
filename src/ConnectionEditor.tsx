import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, Check, ChevronLeft, LoaderCircle, RefreshCw, Smartphone } from 'lucide-react';
import { services } from './catalog';
import { Busy, Modal } from './components';
import { api, errorMessage } from './api';
import IptvCategoryPicker from './IptvCategoryPicker';
import type { IptvCategory, IptvSelection } from './IptvCategoryPicker';
import YouTubeDeviceSignIn from './YouTubeDeviceSignIn';
import { connectionFields as fieldsFor, youtubeAuthMode } from './connection-fields';
import type { YouTubeAuthMode } from './connection-fields';
import type { Connection } from './types';

export type ConnectionFormOptions = { playlist: string; youtubeMode: YouTubeAuthMode; loadedCategories?:IptvSelection };

export default function ConnectionEditor({ adding, editing, editConfig, configuredFields, preview, busy, error, notice, onRefresh,
  onClose: close, onSignIn, onPhoneSetup, onTypeChange, onSubmit }: {
  adding: string;
  editing: Connection | null;
  editConfig: Record<string, string>;
  configuredFields: string[];
  preview: boolean;
  busy: boolean;
  error: string;
  notice: string;
  onRefresh?:()=>Promise<void>;
  onClose: () => void;
  onSignIn: () => void;
  onPhoneSetup: () => void;
  onTypeChange: (type: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>, options: ConnectionFormOptions) => Promise<void>;
}) {
  const [playlist, setPlaylist] = useState('');
  // YouTube connects only by signing in on this screen; saving an older Data API connection switches it over.
  const [youtubeMode] = useState<YouTubeAuthMode>(() => adding === 'youtube' ? 'innertube' : editing ? youtubeAuthMode(editConfig, configuredFields) : 'apiKey');
  const connectionFields = fieldsFor(adding, youtubeMode);
  const youtubeDevice = adding === 'youtube' && youtubeMode === 'innertube';

  const newIptv = !editing && ['xtream', 'm3u'].includes(adding);
  const formRef = useRef<HTMLFormElement>(null), categoryRequest = useRef<AbortController | null>(null);
  const [categories, setCategories] = useState<IptvCategory[]>([]), [selection, setSelection] = useState<IptvSelection>([]);
  const [categoriesReady, setCategoriesReady] = useState(false), [categoriesLoading, setCategoriesLoading] = useState(false), [categoriesError, setCategoriesError] = useState('');
  const [categoryStep, setCategoryStep] = useState(false);
  useEffect(() => () => categoryRequest.current?.abort(), []);
  function invalidateCategories() {
    categoryRequest.current?.abort(); categoryRequest.current = null;
    setCategoriesReady(false); setCategoriesLoading(false); setCategoriesError(''); setCategories([]); setSelection([]);
  }
  async function loadCategories() {
    const form = formRef.current;
    if (!form || !form.reportValidity()) return;
    const previous = categoriesReady ? selection : [];
    invalidateCategories();
    setCategoryStep(true);
    const { name, ...config } = Object.fromEntries(new FormData(form));
    if (adding === 'm3u' && playlist.trim()) config.content = playlist;
    const controller = new AbortController(); categoryRequest.current = controller;
    setCategoriesLoading(true);
    try {
      const result = await api<{categories:IptvCategory[]}>('/connections/categories/preview', {type:adding,name,config}, undefined, controller.signal);
      if (categoryRequest.current !== controller || controller.signal.aborted) return;
      setCategories(result.categories); setSelection(previous === null ? null : previous.filter(id => result.categories.some(c => c.id === id))); setCategoriesReady(true);
    } catch (e) {
      if (categoryRequest.current === controller && !controller.signal.aborted) setCategoriesError(errorMessage(e));
    } finally {
      if (categoryRequest.current === controller) { categoryRequest.current = null; setCategoriesLoading(false); }
    }
  }
  function submitForm(event:FormEvent<HTMLFormElement>) {
    if (newIptv && !categoryStep) {
      event.preventDefault();
      if (categoriesReady) setCategoryStep(true); else void loadCategories();
      return;
    }
    if (newIptv && !categoriesReady) { event.preventDefault(); return; }
    void onSubmit(event, {playlist, youtubeMode, ...(newIptv ? {loadedCategories:selection} : {})});
  }
  return (
    <Modal
      title={newIptv && categoryStep ? 'Choose IPTV categories' : `${editing ? "Edit" : "Connect"} ${adding === "m3u" ? "M3U playlist" : services.find((s) => s.id === adding)?.name || adding}`}
      onClose={close}
      className={newIptv ? 'iptv-setup-dialog' : ''}
    >
      {preview ? (
        <>
          <p>Sign in to save this connection.</p>
          <button className="button primary" onClick={onSignIn}>
            Sign in
          </button>
        </>
      ) : (
        <>
          {newIptv && <div className="iptv-setup-progress" aria-label={`Step ${categoryStep ? 2 : 1} of 2`}>
            <span className={!categoryStep ? 'current' : ''}>1 · Connection details</span><ArrowRight size={14}/><span className={categoryStep ? 'current' : ''}>2 · Categories</span>
          </div>}
          {/* YouTube has nothing to type but its name; its sign-in already happens on the phone. */}
          {!categoryStep && adding !== 'youtube' && new URLSearchParams(location.search).get("phone") !== "1" && (
            <button
              className="button ghost full"
              onClick={() => {
                close();
                onPhoneSetup();
              }}
            >
              <Smartphone size={18} /> Enter details on my phone
            </button>
          )}
          {!categoryStep && !editing && adding === "xtream" && (
            <div className="segmented">
              <button className="selected" type="button">
                Xtream Codes
              </button>
              <button onClick={() => onTypeChange("m3u")}>M3U playlist</button>
            </div>
          )}
          {!categoryStep && !editing && adding === "m3u" && (
            <button
              className="text-button"
              onClick={() => onTypeChange("xtream")}
            >
              <ChevronLeft size={16} /> Use Xtream Codes
            </button>
          )}
          {youtubeDevice && (
            <p className="form-help">
              Browses YouTube the way the YouTube TV app does: your real Home feed, subscriptions, playlists and watch history. You get a short code to enter at google.com/device on your phone.
              {!editing && ' Save first; the sign-in code appears next.'}
            </p>
          )}
          {youtubeDevice && editing && <YouTubeDeviceSignIn connectionId={editing.id} signedIn={!!editing.oauthAuthorized && editing.authMode === 'innertube'} onChanged={async () => { await onRefresh?.(); }} />}
          {!categoryStep && adding === "xtream" && (
            <p className="form-help">
              Add as many IPTV accounts as you like. They share one library.
              Choose your categories in the next step.
            </p>
          )}
          {editing && adding !== 'youtube' && (
            <p className="form-help">
              Saved credentials stay hidden. Leave a saved field empty to
              keep its current value.
            </p>
          )}
          {<form ref={formRef} onSubmit={submitForm} key={`${editing?.id || "new"}:${adding}`} onChange={event => {
            if (newIptv && event.target instanceof HTMLInputElement && event.target.name && event.target.name !== 'name') invalidateCategories();
          }}>
            <div className="connection-details-fields" hidden={categoryStep}>
            <label>
              Connection name
              <input
                name="name"
                defaultValue={editing?.name || ""}
                required
                placeholder={`My ${adding === "m3u" ? "playlist" : services.find((s) => s.id === adding)?.name || "library"}`}
                maxLength={80}
              />
            </label>
            {connectionFields.map((f) => (
              <label key={f.key}>
                {f.label}
                <input
                  name={f.key}
                  type={f.secret ? "password" : "text"}
                  defaultValue={editConfig[f.key] || ""}
                  required={
                    !f.optional && !configuredFields.includes(f.key) && !(adding==='m3u' && f.key==='url' && playlist.trim())
                  }
                  placeholder={
                    configuredFields.includes(f.key) && !editConfig[f.key]
                      ? "Saved — leave blank to keep"
                      : f.placeholder
                  }
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="none"
                />
                {configuredFields.includes(f.key) && (
                  <small className="connection-credential-note">
                    Already saved to your account
                  </small>
                )}
              </label>
            ))}
            {adding === "m3u" && (
              <label>Or paste your M3U playlist
                <textarea aria-label="M3U playlist text" rows={6} value={playlist} maxLength={20*1024*1024} placeholder={'#EXTM3U\n#EXTINF:-1,Channel name\nhttps://…'} onChange={e=>{setPlaylist(e.target.value);if(newIptv)invalidateCategories();}}/>
                <small>Use a playlist URL above or paste its contents. No access to this device’s files is needed.</small>
              </label>
            )}
            </div>
            {newIptv && categoryStep && <section aria-label="Category selection">
              <p className="form-help">Choose what to include. Use the filter icon beside Edit to change your categories later.</p>
              {adding === 'm3u' && <p className="form-help">The playlist downloads as one file; only the selected groups appear in your library.</p>}
              {categoriesError && <div className="form-error" role="alert">{categoriesError}</div>}
              {categoriesLoading && <Busy label="Loading category names…"/>}
              {categoriesReady && <IptvCategoryPicker categories={categories} type={adding} value={selection} onChange={setSelection} disabled={busy}/>}
              <button type="button" className="text-button iptv-picker-retry" disabled={busy || categoriesLoading} onClick={() => void loadCategories()}><RefreshCw size={14}/>{categoriesReady ? 'Reload category names' : 'Try again'}</button>
            </section>}
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            {notice && (
              <div className="form-help" role="status">
                {notice}
              </div>
            )}
            <div className={newIptv && categoryStep ? 'iptv-setup-actions' : ''}>
            {newIptv && categoryStep && <button type="button" className="button ghost" disabled={busy} onClick={() => { categoryRequest.current?.abort(); categoryRequest.current = null; setCategoriesLoading(false); setCategoryStep(false); }}><ChevronLeft size={18}/>Back</button>}
            <button type="submit" className="button primary full" disabled={busy || newIptv && categoryStep && !categoriesReady}>
              {busy ? (
                <LoaderCircle className="spin" size={18} />
              ) : (
                newIptv && !categoryStep ? <ArrowRight size={18}/> : <Check size={18} />
              )}
              {newIptv && !categoryStep ? 'Next: choose categories' : 'Save connection'}
            </button>
            </div>
          </form>}
        </>
      )}
    </Modal>
  );
}

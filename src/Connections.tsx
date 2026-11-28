import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ArrowLeft, ArrowUpRight, Cable, Plus, Smartphone } from 'lucide-react';
import { api, errorMessage } from "./api";
import { Busy } from "./components";
import type { Connection } from "./types";
import ConnectionEditor from './ConnectionEditor';
import type { ConnectionFormOptions } from './ConnectionEditor';
import ConnectionServices from './ConnectionServices';
import SavedConnections from './SavedConnections';
import PhoneSetupDialog from './PhoneSetupDialog';
import RemoveConnectionDialog from './RemoveConnectionDialog';
import IptvCategoryDialog from './IptvCategoryDialog';
import YouTubeSignIn from './YouTubeSignIn';
export default function Connections({
  connections,
  onRefresh,
  onBrowse,
  initialType,
  onInitialUsed,
  preview,
  onSignIn,
  embedded = false,
}: {
  connections: Connection[];
  onRefresh: () => Promise<void>;
  onBrowse: (c: Connection) => void;
  initialType?: string;
  onInitialUsed: () => void;
  preview: boolean;
  onSignIn: () => void;
  embedded?: boolean;
}) {
  const [adding, setAdding] = useState<string | null>(initialType || null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [deleting, setDeleting] = useState<Connection | null>(null);
  const [editing, setEditing] = useState<Connection | null>(null);
  // A new YouTube connection is made on the phone sign-in page, not in the connection form.
  const youtubeCreated = useRef<Connection | null>(null);
  const [categoryConnection, setCategoryConnection] = useState<Connection | null>(null);
  const [editConfig, setEditConfig] = useState<Record<string, string>>({});
  const [configuredFields, setConfiguredFields] = useState<string[]>([]);
  const [phoneSetup, setPhoneSetup] = useState(false);
  const [publicUrl, setPublicUrl] = useState(location.origin);
  useEffect(() => {
    if (preview) return;
    let dead = false;
    api<{ publicUrl?: string }>("/settings")
      .then((s) => {
        if (!dead && s.publicUrl) setPublicUrl(s.publicUrl.replace(/\/$/, ""));
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [preview]);
  const phoneLink = `${publicUrl}/?view=connections&phone=1`;
  function beginAdd(type: string) {
    youtubeCreated.current = null;
    // The YouTube sign-in replaces the whole page; start it at the top.
    if (type === 'youtube') window.scrollTo({ top: 0 });
    setEditing(null);
    setEditConfig({});
    setConfiguredFields([]);
    setNotice('');
    setError('');
    setAdding(type);
  }
  async function editConnection(c: Connection) {
    await run(async () => {
      const r = await api<{
        connection: Connection;
        config: Record<string, string>;
        configuredFields: string[];
      }>(`/connections/${c.id}/config`);
      setEditing(r.connection);
      setEditConfig(r.config);
      setConfiguredFields(r.configuredFields);
      setAdding(c.type);
    });
  }
  function close() {
    setAdding(null);
    youtubeCreated.current = null;
    setEditing(null);
    setEditConfig({});
    setConfiguredFields([]);
    setError("");
    onInitialUsed();
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>, { playlist, youtubeMode, loadedCategories }: ConnectionFormOptions) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    await run(async () => {
      const { name, ...config } = f;
      if (adding === "m3u" && playlist) config.content = playlist;
      if (adding === "youtube") config.authMode = youtubeMode;
      const newIptv = !editing && ['xtream', 'm3u'].includes(adding || '');
      if (newIptv && loadedCategories === undefined) throw new Error('Load and choose IPTV categories before saving.');
      const r = await api<{ connection: Connection }>(
        editing ? `/connections/${editing.id}` : "/connections",
        {
          type: adding,
          name,
          config: { ...config, ...(newIptv ? { loadedCategories } : {}) },
        },
        editing ? "PUT" : "POST",
      );
      await onRefresh();
      if (adding === 'youtube' && youtubeMode === 'innertube' && !editing) {
        // Keep the editor open on the saved connection so the Google sign-in code can be requested next.
        const saved = await api<{ connection: Connection; config: Record<string, string>; configuredFields: string[] }>(`/connections/${r.connection.id}/config`);
        setEditing(saved.connection); setEditConfig(saved.config); setConfiguredFields(saved.configuredFields);
        setNotice(`${r.connection.name} saved. Now sign in with Google on this screen.`);
        return;
      }
      setNotice(
        newIptv ? `${r.connection.name} saved with your chosen categories.` : `${r.connection.name} saved. Test the connection to check access.`,
      );
      close();
    });
  }
  const createYouTube = useCallback(async () => {
    const r = await api<{ connection: Connection }>('/connections', { type: 'youtube', name: 'YouTube', config: { authMode: 'innertube' } });
    youtubeCreated.current = r.connection;
    await onRefresh();
    return r.connection;
  }, [onRefresh]);
  // A YouTube connection left half-way through sign-in is reused rather than duplicated.
  const pendingYouTube = connections.find(c => c.type === 'youtube' && c.authMode === 'innertube' && !c.oauthAuthorized && !c.shared);
  const youtubeSignedIn = useCallback(async () => {
    const created = youtubeCreated.current || pendingYouTube;
    await onRefresh();
    close();
    if (created) onBrowse(created);
  }, [onRefresh, onBrowse, pendingYouTube]);
  if (adding === 'youtube' && !editing && !preview) return (
    <section className="page-section youtube-hub">
      <button className="text-button youtube-signin-back" onClick={close}><ArrowLeft size={16} /> Back to connections</button>
      <YouTubeSignIn connection={pendingYouTube} canManage onSignedIn={youtubeSignedIn} onCreateConnection={createYouTube} />
    </section>
  );
  return (
    <section className="page-section">
      {!embedded && <div className="page-heading">
        <div>
          <span className="eyebrow">ALL YOUR WORLDS, TOGETHER</span>
          <h1>Your connections</h1>
          <p>
            Your API keys and provider accounts, saved securely with your
            TesPlay account.
          </p>
        </div>
        <span className="count-pill">
          <Cable size={16} />
          {connections.length} connected
        </span>
      </div>}
      {preview && (
        <div className="notice">
          <span>Sign in to save connections securely on your server.</span>
          <button className="text-button" onClick={onSignIn}>
            Sign in <ArrowUpRight size={16} />
          </button>
        </div>
      )}
      {!preview && (
        <div className="phone-setup-notice">
          <div>
            <h3>Set it up on your phone</h3>
            <p>
              Scan once to add provider URLs, passwords and API keys with your
              phone’s keyboard. Connections appear on this screen automatically.
            </p>
          </div>
          <button
            className="button ghost"
            onClick={() => setPhoneSetup(true)}
          >
            <Smartphone size={19} /> Set up with QR
          </button>
        </div>
      )}
      {error && !adding && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      {connections.some(c => ['xtream','m3u'].includes(c.type)) && <div className="iptv-bundle-notice"><span>All IPTV connections appear together in one library.</span><button className="button ghost small" onClick={() => beginAdd('xtream')}><Plus size={16}/>Add IPTV connection</button></div>}
      <SavedConnections connections={connections} busy={busy} onBrowse={onBrowse} onEdit={editConnection} onCategories={setCategoryConnection}
        onDelete={setDeleting} onTest={c => run(async () => {
          const result = await api<{ message: string }>(`/connections/${c.id}/test`, {});
          setNotice(result.message);
        })}/>
      <ConnectionServices preview={preview} onSignIn={onSignIn} onAdd={beginAdd}/>
      {categoryConnection && <IptvCategoryDialog key={categoryConnection.id} connection={categoryConnection} onClose={() => setCategoryConnection(null)} onSaved={onRefresh}/>}
      {adding && <ConnectionEditor key={`${editing?.id || 'new'}:${adding}`} adding={adding} editing={editing} editConfig={editConfig} configuredFields={configuredFields}
        preview={preview} busy={busy} error={error} notice={notice}
        onRefresh={async () => { await onRefresh(); if (editing) { const saved = await api<{ connection: Connection }>(`/connections/${editing.id}/config`).catch(() => null); if (saved) setEditing(saved.connection); } }}
        onClose={close} onSignIn={onSignIn} onPhoneSetup={() => setPhoneSetup(true)} onTypeChange={setAdding}
        onSubmit={submit}/>}
      {deleting && <RemoveConnectionDialog deleting={deleting} busy={busy} error={error} onClose={() => setDeleting(null)}
        onConfirm={() => run(async () => {
          await api(`/connections/${deleting.id}`, {}, 'DELETE');
          setDeleting(null);
          await onRefresh();
        })}/>}
      {phoneSetup && <PhoneSetupDialog phoneLink={phoneLink} onRefresh={onRefresh} onClose={() => setPhoneSetup(false)} onError={setError}/>}
      {busy && !adding && (
        <Busy label="Checking connection" />
      )}
    </section>
  );
}

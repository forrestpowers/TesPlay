import { Plus } from 'lucide-react';
import { services } from './catalog';
import { YouTubeLogo } from './components';

export default function ConnectionServices({ preview, onSignIn, onAdd }: {
  preview: boolean;
  onSignIn: () => void;
  onAdd: (type: string) => void;
}) {
  return (
    <div className="connection-grid">
      {services.map((s) => (
        <article className="connection-card" key={s.id}>
          <div className="connection-card-top">
            <div
              className={`service-mark ${s.id}`}
              style={{ color: s.color }}
            >
              {s.id === "youtube" ? <YouTubeLogo/> : s.letters}
            </div>
            <span className="type-label">
              Personal connection
            </span>
          </div>
          <h2>{s.name}</h2>
          <p>{s.description}</p>
          <button
              className="button ghost"
              onClick={() =>
                preview
                  ? onSignIn()
                  : onAdd(s.id)
              }
            >
              <Plus size={17} />
              Connect {s.name}
            </button>
        </article>
      ))}
    </div>
  );
}

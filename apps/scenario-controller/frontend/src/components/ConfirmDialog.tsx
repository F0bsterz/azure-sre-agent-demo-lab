/**
 * Confirmation gate for fault injection.
 *
 * Injecting a fault is a destructive-looking action even in a lab, so it is
 * never one click. The dialog also surfaces the suggested Azure SRE Agent
 * prompt, which is what the demonstrator will paste next.
 */

interface Props {
  open: boolean;
  title: string;
  body: string;
  prompt?: string;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  prompt,
  confirmLabel,
  destructive,
  busy,
  onConfirm,
  onCancel,
}: Props) {
  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div className="modal">
        <h3>{title}</h3>
        <p>{body}</p>
        {prompt ? (
          <>
            <p style={{ marginTop: 12 }}>Suggested Azure SRE Agent prompt:</p>
            <div className="prompt">{prompt}</div>
          </>
        ) : null}
        <div className="modal-actions">
          <button className="btn ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className={destructive ? 'btn danger' : 'btn primary'} onClick={onConfirm} disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

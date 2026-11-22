import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

// A minimal full-screen overlay: dark backdrop, a close button, and content
// that scrolls in both directions. For now it only shows the "Expand Grid"
// copy of a wide table. Phase 3A will upgrade this same component (images,
// pinch-zoom, double-tap, pan, swipe to close); nothing of that is here yet.

interface ImageLightboxProps {
  onClose: () => void;
  /** Accessible name of the dialog. */
  label: string;
  /** Styles for the panel the content sits on (so it can follow the reader's theme). */
  contentStyle?: CSSProperties;
  children: ReactNode;
}

export default function ImageLightbox({ onClose, label, contentStyle, children }: ImageLightboxProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={label} onClick={onClose}>
      <button
        ref={closeRef}
        type="button"
        className="lightbox-close"
        aria-label="Close"
        onClick={(event) => {
          // Already closing: don't also reach the backdrop's own close.
          event.stopPropagation();
          onClose();
        }}
      >
        &times;
      </button>
      <div className="lightbox-content" style={contentStyle} onClick={(event) => event.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

/** Mounts an existing DOM node (such as a cloned table) as the content of a React tree. */
export function DomNode({ node }: { node: Node }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren(node);
    return () => host.replaceChildren();
  }, [node]);
  return <div ref={hostRef} className="lightbox-dom" />;
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ImageLightbox from './ImageLightbox';
import type { FullImage } from '../lib/imageProcessor';

// Layout and touch gestures are checked in a real browser (scripts/verify/images-chromium.mjs)
// and the maths in lightboxGestures.test.ts; this covers what jsdom can: structure, content,
// closing, and the lifetime of the full-detail copy.

afterEach(cleanup);

const picture = { src: 'blob:http://localhost/preview', width: 4000, height: 6000, alt: 'A map' };

function fullImage(url = 'blob:http://localhost/full'): { image: FullImage; release: ReturnType<typeof vi.fn> } {
  const release = vi.fn();
  return { image: { url, width: 2731, height: 4096, release: () => release() }, release };
}

describe('ImageLightbox - the shell', () => {
  it('is a modal dialog with a close button', () => {
    render(<ImageLightbox label="Table" onClose={() => {}} node={document.createElement('table')} />);
    const dialog = screen.getByRole('dialog', { name: 'Table' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByLabelText('Close')).toBeTruthy();
  });

  it('closes from the close button (once) and from Escape', () => {
    const onClose = vi.fn();
    render(<ImageLightbox label="x" onClose={onClose} image={picture} />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('keeps the page underneath from handling touches: the stage owns them', () => {
    render(<ImageLightbox label="x" onClose={() => {}} image={picture} />);
    expect(document.querySelector('.lightbox-stage')).not.toBeNull();
  });
});

describe('ImageLightbox - a picture', () => {
  it('shows the picture as it is in the page straight away, sized to the picture', () => {
    render(<ImageLightbox label="A map" onClose={() => {}} image={picture} />);
    const img = screen.getByAltText('A map') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(picture.src);
    const box = document.querySelector('.lightbox-content') as HTMLElement;
    expect(box.style.width).toBe('4000px');
    expect(box.style.height).toBe('6000px');
  });

  it('says it is loading when there is nothing to show yet', () => {
    render(<ImageLightbox label="x" onClose={() => {}} image={{ ...picture, src: undefined }} />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });

  it('swaps to the full-detail copy when it is ready, and frees it on close', async () => {
    const full = fullImage();
    const loadFull = vi.fn(async () => full.image);
    const { unmount } = render(<ImageLightbox label="x" onClose={() => {}} image={picture} loadFull={loadFull} />);
    expect(loadFull).toHaveBeenCalledTimes(1);

    await waitFor(() => expect((screen.getByAltText('A map') as HTMLImageElement).getAttribute('src')).toBe(full.image.url));
    expect(full.release).not.toHaveBeenCalled();

    unmount();
    expect(full.release).toHaveBeenCalledTimes(1);
  });

  it('frees a full-detail copy that finishes decoding AFTER the lightbox was closed', async () => {
    const full = fullImage();
    let finish!: (value: FullImage) => void;
    const loadFull = () => new Promise<FullImage | null>((resolve) => (finish = resolve));
    const { unmount } = render(<ImageLightbox label="x" onClose={() => {}} image={picture} loadFull={loadFull} />);
    unmount();
    await act(async () => finish(full.image));
    expect(full.release).toHaveBeenCalledTimes(1);
  });

  it('keeps showing the in-page picture if the full-detail decode fails or yields nothing', async () => {
    render(<ImageLightbox label="x" onClose={() => {}} image={picture} loadFull={async () => null} />);
    await act(async () => {});
    expect((screen.getByAltText('A map') as HTMLImageElement).getAttribute('src')).toBe(picture.src);

    cleanup();
    render(
      <ImageLightbox
        label="x"
        onClose={() => {}}
        image={picture}
        loadFull={() => Promise.reject(new Error('decode failed'))}
      />,
    );
    await act(async () => {});
    expect((screen.getByAltText('A map') as HTMLImageElement).getAttribute('src')).toBe(picture.src);
  });

  it('offers Invert only when asked, and toggles a filter on the picture', () => {
    const { rerender } = render(<ImageLightbox label="x" onClose={() => {}} image={picture} />);
    expect(screen.queryByText('Invert')).toBeNull();

    rerender(<ImageLightbox label="x" onClose={() => {}} image={picture} canInvert />);
    const button = screen.getByText('Invert');
    const img = screen.getByAltText('A map') as HTMLImageElement;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(img.style.filter).toBe('');
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(img.style.filter).toContain('invert(1)');
    fireEvent.click(button);
    expect(img.style.filter).toBe('');
  });

  it('does not offer Invert on a table', () => {
    render(<ImageLightbox label="Table" onClose={() => {}} node={document.createElement('table')} canInvert />);
    expect(screen.queryByText('Invert')).toBeNull();
  });
});

describe('ImageLightbox - a table (Expand Grid)', () => {
  it('mounts the given DOM node, on a sheet styled as asked, and removes it on close', () => {
    const table = document.createElement('table');
    table.innerHTML = '<tbody><tr><td>cell</td></tr></tbody>';
    const { unmount } = render(<ImageLightbox label="Table" onClose={() => {}} node={table} contentStyle={{ background: 'rgb(1, 2, 3)' }} />);
    expect(document.querySelector('.lightbox-dom table')).toBe(table);
    expect((document.querySelector('.lightbox-dom') as HTMLElement).style.background).toBe('rgb(1, 2, 3)');
    unmount();
    expect(table.isConnected).toBe(false);
  });
});

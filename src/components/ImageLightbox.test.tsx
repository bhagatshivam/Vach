import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ImageLightbox, { DomNode } from './ImageLightbox';

afterEach(cleanup);

describe('ImageLightbox (minimal shell)', () => {
  it('is a modal dialog with a close button, showing its content', () => {
    render(
      <ImageLightbox label="Table" onClose={() => {}}>
        <p>hello</p>
      </ImageLightbox>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Table' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByLabelText('Close')).toBeTruthy();
    expect(screen.getByText('hello')).toBeTruthy();
  });

  it('closes from the close button, the backdrop and Escape - but not from a tap on the content', () => {
    const onClose = vi.fn();
    render(
      <ImageLightbox label="Table" onClose={onClose}>
        <p>content</p>
      </ImageLightbox>,
    );
    fireEvent.click(screen.getByText('content'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('the content panel is the part that scrolls (both axes are left to CSS overflow: auto)', () => {
    render(
      <ImageLightbox label="Table" onClose={() => {}} contentStyle={{ background: 'rgb(1, 2, 3)' }}>
        <p>x</p>
      </ImageLightbox>,
    );
    const panel = document.querySelector('.lightbox-content') as HTMLElement;
    expect(panel.style.background).toBe('rgb(1, 2, 3)');
  });

  it('DomNode mounts an existing DOM node (a cloned table) and removes it on unmount', () => {
    const table = document.createElement('table');
    table.innerHTML = '<tbody><tr><td>cell</td></tr></tbody>';
    const { unmount } = render(<DomNode node={table} />);
    expect(document.querySelector('.lightbox-dom table')).toBe(table);
    unmount();
    expect(table.isConnected).toBe(false);
  });

  it('has no zoom or pan machinery yet (that is Phase 3A)', () => {
    render(
      <ImageLightbox label="Table" onClose={() => {}}>
        <p>x</p>
      </ImageLightbox>,
    );
    expect(document.querySelector('[class*="zoom"], [class*="pan"]')).toBeNull();
  });
});

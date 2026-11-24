// Path handling shared by the EPUB reader and its table-of-contents loader.

/** decodeURIComponent that keeps a segment as it is when it is not valid percent-encoding, instead of throwing. */
export function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Resolves a zip-relative href (as found in an OPF manifest item, a TOC entry
 * or a chapter's own <img src>) against the directory of the file that
 * referenced it. Handles "../" and "./" segments, percent-encoding (a
 * malformed escape is kept literally) and a small amount of real-world
 * sloppiness (fragments/queries on hrefs, leading "/"). Never throws.
 */
export function resolveRelativePath(baseDir: string, relativeHref: string): string {
  const clean = relativeHref.split('#')[0].split('?')[0];

  if (clean.startsWith('/')) {
    return clean.slice(1).split('/').filter(Boolean).map(safeDecode).join('/');
  }

  const baseParts = baseDir ? baseDir.split('/').filter(Boolean) : [];
  const relParts = clean.split('/').filter((p) => p.length > 0 && p !== '.');

  const stack = [...baseParts];
  for (const part of relParts) {
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.map(safeDecode).join('/');
}

export function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

/** The part of an href after "#", decoded; undefined if there is none or it is empty. */
export function fragmentOf(href: string): string | undefined {
  const hash = href.indexOf('#');
  if (hash === -1) return undefined;
  const fragment = safeDecode(href.slice(hash + 1));
  return fragment ? fragment : undefined;
}

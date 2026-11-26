// A tiny deterministic .docx (OOXML) writer for the sample books and the benchmarks. Only what Vach's samples need:
// styled headings, paragraphs with runs, lists, tables (incl. merged cells), an inline PNG, a footnote and an endnote.
// Deterministic: fixed file dates, fixed ordering - the same call gives the same bytes.

import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';

const FIXED = new Date(Date.UTC(2020, 0, 1));
export const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

// ---- body pieces ------------------------------------------------------------------------------------------------------

/** A run of text, optionally bold / italic. */
export const run = (text, { bold = false, italic = false } = {}) =>
  `<w:r>${bold || italic ? `<w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

/** A paragraph from runs (or a plain string), optionally with a style id. */
export const p = (content, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${typeof content === 'string' && !content.startsWith('<') ? run(content) : content}</w:p>`;
export const heading = (level, text) => p(run(text), `Heading${level}`);
/** A list item: numId 1 = bullets, 2 = numbers. */
export const li = (text, numId = 1, level = 0) => `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${run(text)}</w:p>`;

/** A table from rows of cell specs: a string, or { text, span, vMerge: 'restart' | 'continue' }. */
export function table(rows, { header = false } = {}) {
  const cols = Math.max(...rows.map((r) => r.reduce((n, c) => n + (typeof c === 'object' ? (c.span ?? 1) : 1), 0)));
  const grid = Array.from({ length: cols }, () => '<w:gridCol w:w="1200"/>').join('');
  const body = rows
    .map((cells, rowIndex) => {
      const tcs = cells
        .map((cell) => {
          const spec = typeof cell === 'object' ? cell : { text: cell };
          const props = [spec.span > 1 ? `<w:gridSpan w:val="${spec.span}"/>` : '', spec.vMerge === 'restart' ? '<w:vMerge w:val="restart"/>' : spec.vMerge === 'continue' ? '<w:vMerge/>' : ''].join('');
          return `<w:tc><w:tcPr>${props}</w:tcPr>${p(spec.text ? run(spec.text, { bold: header && rowIndex === 0 }) : '')}</w:tc>`;
        })
        .join('');
      return `<w:tr>${header && rowIndex === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${tcs}</w:tr>`;
    })
    .join('');
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`;
}

/** An inline picture referencing relationship `rId` (an image part added with `images`). */
export const picture = (rId, widthEmu, heightEmu, alt = 'A picture') =>
  `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="${widthEmu}" cy="${heightEmu}"/><wp:docPr id="1" name="Picture" descr="${esc(alt)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

export const footnoteRef = (id) => `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;
export const endnoteRef = (id) => `<w:r><w:rPr><w:rStyle w:val="EndnoteReference"/></w:rPr><w:endnoteReference w:id="${id}"/></w:r>`;
/** An internal hyperlink to a bookmark. */
export const link = (anchor, text) => `<w:hyperlink w:anchor="${anchor}">${run(text)}</w:hyperlink>`;
export const bookmark = (id, name, inner) => `<w:bookmarkStart w:id="${id}" w:name="${name}"/>${inner}<w:bookmarkEnd w:id="${id}"/>`;

// ---- fixed parts -------------------------------------------------------------------------------------------------------

const styleXml = (id, name, extra = '') => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:qFormat/>${extra}</w:style>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${styleXml('Heading1', 'heading 1', '<w:pPr><w:outlineLvl w:val="0"/></w:pPr>')}
${styleXml('Heading2', 'heading 2', '<w:pPr><w:outlineLvl w:val="1"/></w:pPr>')}
${styleXml('Heading3', 'heading 3', '<w:pPr><w:outlineLvl w:val="2"/></w:pPr>')}
${styleXml('ListParagraph', 'List Paragraph')}
<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="EndnoteReference"><w:name w:val="endnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${NS}>
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

function notesXml(kind, notes) {
  const tag = kind === 'footnote' ? 'footnote' : 'endnote';
  const root = kind === 'footnote' ? 'footnotes' : 'endnotes';
  const refMark = kind === 'footnote' ? '<w:footnoteRef/>' : '<w:endnoteRef/>';
  const parts = [`<w:${tag} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${tag}>`, `<w:${tag} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${tag}>`];
  for (const [id, text] of notes) parts.push(`<w:${tag} w:id="${id}"><w:p><w:r>${refMark}</w:r>${run(' ' + text)}</w:p></w:${tag}>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${root} ${NS}>${parts.join('')}</w:${root}>`;
}

/**
 * Builds the .docx bytes.
 * @param {string} body            the inside of <w:body>
 * @param {object} [options]       { title, images: [{ name, bytes }], footnotes: [[id, text]], endnotes: [[id, text]] }
 */
export async function buildDocx(body, { title, images = [], footnotes = [], endnotes = [] } = {}) {
  const zip = new JSZip();
  const add = (path, data) => zip.file(path, data, { compression: 'DEFLATE', date: FIXED, createFolders: false });
  const hasNotes = footnotes.length > 0 || endnotes.length > 0;

  const types = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Default Extension="png" ContentType="image/png"/>',
    '<Default Extension="jpeg" ContentType="image/jpeg"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    hasNotes ? '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/><Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>' : '',
  ].join('');
  add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${types}</Types>`);
  add('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>');
  add(
    'docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${title ? `<dc:title>${esc(title)}</dc:title>` : ''}<dc:creator>Vach samples</dc:creator></cp:coreProperties>`,
  );
  add('word/styles.xml', STYLES);
  add('word/numbering.xml', NUMBERING);
  const rels = [
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
  ];
  if (hasNotes) {
    add('word/footnotes.xml', notesXml('footnote', footnotes));
    add('word/endnotes.xml', notesXml('endnote', endnotes));
    rels.push('<Relationship Id="rIdFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>');
    rels.push('<Relationship Id="rIdEndnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>');
  }
  images.forEach((image, i) => {
    add(`word/media/${image.name}`, image.bytes);
    rels.push(`<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${image.name}"/>`);
  });
  add('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
  add('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: 'uint8array', platform: 'UNIX', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

// ---- PNG ---------------------------------------------------------------------------------------------------------------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const u32 = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
};

/** An RGB PNG from `pixel(x, y) -> [r, g, b]`. `level` 0 stores the data uncompressed (for incompressible benchmark images). */
export function png(width, height, pixel, level = 6) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o + 1 + x * 3] = r;
      raw[o + 2 + x * 3] = g;
      raw[o + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.concat([u32(width), u32(height), Buffer.from([8, 2, 0, 0, 0])])),
    chunk('IDAT', deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- text --------------------------------------------------------------------------------------------------------------

const WORDS = 'the of and to in a is that for it as was with be by on not he this are or his from at which but have an had they you were their one all we can her has there been if more when will would who so no'.split(' ');
const NOUNS = 'river road lamp valley caravan harbour letter window garden engine market bridge winter orchard signal ledger compass lantern meadow station'.split(' ');

/** A seeded pseudo-random generator, so text is the same on every run. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** A sentence-like paragraph of at least `words` words. */
export function paragraphText(random, words) {
  const sentences = [];
  let count = 0;
  while (count < words) {
    const length = 6 + Math.floor(random() * 12);
    const parts = [];
    for (let i = 0; i < length; i++) parts.push(random() < 0.3 ? NOUNS[Math.floor(random() * NOUNS.length)] : WORDS[Math.floor(random() * WORDS.length)]);
    parts[0] = parts[0][0].toUpperCase() + parts[0].slice(1);
    sentences.push(parts.join(' ') + '.');
    count += length;
  }
  return sentences.join(' ');
}

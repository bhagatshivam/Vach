// What the Word converter hands back, and the one constant both sides of the thread boundary share. No imports: this
// is loaded by the reader's own code, which must not pull the converter (mammoth) in.

/** The scheme the converter writes into <img src>; docx.ts swaps each for the picture it names. */
export const DOCX_IMAGE_SCHEME = 'vach-docx-image:';

export interface ConvertedImage {
  /** The number after DOCX_IMAGE_SCHEME in the HTML. */
  id: number;
  contentType: string;
  bytes: Uint8Array;
}

export interface DocxConversion {
  html: string;
  images: ConvertedImage[];
  /** dc:title from docProps/core.xml, if the document has one. */
  title: string | null;
  /** What mammoth said it could not translate (unsupported images, styles it ignored...). */
  warnings: string[];
}

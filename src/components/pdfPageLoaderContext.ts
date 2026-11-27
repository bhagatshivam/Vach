import { createContext } from 'react';
import type { PdfPageLoader } from '../lib/pdfPageLoader';

/** The PDF page loader, when the open book is a PDF: each chapter (page) registers its placeholder with it as it mounts. */
export const PdfPageLoaderContext = createContext<PdfPageLoader | null>(null);

// Stands in for src/lib/pdf.ts inside the frame check: no PDF is opened there, and the real module pulls in a worker.
export async function openPdf(): Promise<never> {
  throw new Error('PDF is not available in the frame check');
}

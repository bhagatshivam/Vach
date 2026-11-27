// Stands in for src/lib/fileBridge.ts in the measurement bundle, so a synthetic PDF can be "opened" without the native plugin.
export class FileTooLargeError extends Error {}

export async function createFileSource() {
  return { size: 1, read: async () => new Uint8Array(0) };
}

// sha256 的 Web Worker (#23): 收 { id, file }, 回 { id, progress } 若干次, 最后 { id, hex } 或 { id, error }
import { hashBlob } from './sha256';

self.onmessage = async (e: MessageEvent<{ id: number; file: Blob }>) => {
  const { id, file } = e.data;
  try {
    const hex = await hashBlob(file, (progress) => self.postMessage({ id, progress }));
    self.postMessage({ id, hex });
  } catch (err) {
    self.postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};

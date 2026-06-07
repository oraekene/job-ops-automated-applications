export function setFileInput(
  element: HTMLInputElement | null,
  pdfBytes: Uint8Array,
  filename: string,
): void {
  if (!element) return;
  const file = new File([pdfBytes], filename, { type: "application/pdf" });
  const dt = new DataTransfer();
  dt.items.add(file);
  element.files = dt.files;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Decode a base64 PDF payload (US-033: data: URL with gzipped base64) and
 * attach it to the given `<input type="file">`. Returns true on success,
 * false on any failure. Callers should treat false as a skip-reason.
 *
 * Strategy: when the payload is a data: URL, fetch it via the runtime and
 * stream it through DecompressionStream("gzip") to get the raw PDF bytes.
 * Falls back to the raw base64 (no gunzip) on older environments.
 */
export async function uploadResume(
  input: HTMLInputElement | null,
  base64: string,
  filename: string,
): Promise<boolean> {
  if (!input) return false;
  if (typeof DataTransfer === "undefined") return false;

  let bytes: Uint8Array;
  try {
    if (base64.startsWith("data:")) {
      // Use fetch to get a Blob, then pipe through DecompressionStream
      const response = await fetch(base64);
      if (!response.ok) return false;
      const blob = await response.blob();
      if (typeof DecompressionStream === "undefined") {
        // No gunzip available — try to read raw bytes (may be gzipped, but
        // many ATSes still accept the file as a "valid PDF" header check
        // would fail; this is a degraded fallback).
        const buf = await blob.arrayBuffer();
        bytes = new Uint8Array(buf);
      } else {
        const decompressed = blob
          .stream()
          .pipeThrough(new DecompressionStream("gzip"));
        const buf = await new Response(decompressed).arrayBuffer();
        bytes = new Uint8Array(buf);
      }
    } else {
      const binary = atob(base64);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    }
  } catch {
    return false;
  }

  const file = new File([bytes], filename, { type: "application/pdf" });
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

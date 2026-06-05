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
 * Decode a base64 PDF and attach it to the given `<input type="file">`.
 * Returns true on success, false on any failure (no input, no DataTransfer,
 * malformed base64). Callers should treat false as a skip-reason: 'no resume
 * upload input' (or the underlying error), so the queue can continue.
 */
export function uploadResume(
  input: HTMLInputElement | null,
  base64: string,
  filename: string,
): boolean {
  if (!input) return false;
  if (typeof DataTransfer === "undefined") return false;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const binary = atob(base64);
    const buffer = new ArrayBuffer(binary.length);
    bytes = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
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

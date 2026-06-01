export function setFileInput(element: HTMLInputElement | null, pdfBytes: Uint8Array, filename: string): void {
  if (!element) return;
  const file = new File([pdfBytes], filename, { type: 'application/pdf' });
  const dt = new DataTransfer();
  dt.items.add(file);
  element.files = dt.files;
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

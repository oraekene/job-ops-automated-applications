declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  interface PdfAnnotation {
    subtype: string;
    url?: string;
  }

  interface PdfTextItem {
    str?: string;
    transform: number[];
  }

  interface PdfTextContent {
    items: PdfTextItem[];
  }

  interface PdfPage {
    getTextContent(): Promise<PdfTextContent>;
    getAnnotations(): Promise<PdfAnnotation[]>;
  }

  interface PdfDocument {
    numPages: number;
    getPage(pageNumber: number): Promise<PdfPage>;
    destroy(): Promise<void>;
  }

  interface LoadingTask {
    promise: Promise<PdfDocument>;
  }

  export function getDocument(data: { data: ArrayBuffer }): LoadingTask;
  export const version: string;
}

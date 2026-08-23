import fs from "fs/promises";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { createWorker } from "tesseract.js";
import mammoth from "mammoth";
import { cleanDocumentText } from "./cleaner.js";

let tesseractWorker = null;

async function getOCRWorker() {
  if (!tesseractWorker) {
    tesseractWorker = await createWorker("eng");
  }
  return tesseractWorker;
}

/**
 * Extract text from an image buffer or file path using Tesseract OCR
 */
export async function extractTextFromImage(imageBufferOrPath) {
  const worker = await getOCRWorker();
  const { data: { text } } = await worker.recognize(imageBufferOrPath);
  return cleanDocumentText(text);
}

/**
 * Extract text from PDF buffer
 */
export async function extractTextFromPDF(pdfBuffer) {
  const data = await pdfParse(pdfBuffer);
  let extracted = data.text || "";

  // Check if extracted text is sparse (e.g. scanned PDF with no text layer)
  const alphaChars = (extracted.match(/[A-Za-z]/g) || []).length;
  if (alphaChars < 50 && data.numpages > 0) {
    // If it's a scanned PDF and text layer is empty, inform the client
    // Note: Node-based full PDF rendering to canvas requires native canvas binaries,
    // so we provide clean fallback and extraction.
    return {
      text: cleanDocumentText(extracted),
      pages: data.numpages,
      isScanned: true
    };
  }

  return {
    text: cleanDocumentText(extracted),
    pages: data.numpages,
    isScanned: false
  };
}

/**
 * Extract text from DOCX Word buffer
 */
export async function extractTextFromWord(docxBuffer) {
  const result = await mammoth.extractRawText({ buffer: docxBuffer });
  return cleanDocumentText(result.value);
}

/**
 * Master parser: handles any supported document or image
 */
export async function parseDocument(fileBuffer, originalFilename, mimeType = "") {
  const ext = (originalFilename || "").split(".").pop().toLowerCase();
  let rawText = "";
  let meta = {};

  if (ext === "pdf" || mimeType.includes("pdf")) {
    const pdfRes = await extractTextFromPDF(fileBuffer);
    rawText = pdfRes.text;
    meta = { pages: pdfRes.pages, isScanned: pdfRes.isScanned };
  } else if (["png", "jpg", "jpeg", "webp"].includes(ext) || mimeType.startsWith("image/")) {
    rawText = await extractTextFromImage(fileBuffer);
    meta = { type: "image_ocr" };
  } else if (ext === "docx" || mimeType.includes("wordprocessingml")) {
    rawText = await extractTextFromWord(fileBuffer);
    meta = { type: "docx" };
  } else if (["txt", "md", "csv", "json"].includes(ext) || mimeType.startsWith("text/")) {
    rawText = cleanDocumentText(fileBuffer.toString("utf-8"));
    meta = { type: "text" };
  } else {
    // Fallback try text conversion
    rawText = cleanDocumentText(fileBuffer.toString("utf-8"));
    meta = { type: "unknown" };
  }

  return {
    text: rawText,
    filename: originalFilename,
    meta
  };
}

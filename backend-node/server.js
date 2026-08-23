import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import { cleanDocumentText } from "./services/cleaner.js";
import { parseDocument } from "./services/ocr.js";
import { summarizeText } from "./services/summarizer.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Multer in-memory storage for uploaded files
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 } // 30MB
});

// Health check
app.get("/", (req, res) => {
  res.json({ message: "Document Summary Assistant (Node.js OCR & NLP Backend) is running" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/**
 * Endpoint 1: Clean raw text
 * Normalizes unnecessary capital letters, removes meaningless noise tokens,
 * repairs broken words, and enforces grammar.
 */
app.post("/api/clean", (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Please provide a valid text string in req.body.text" });
    }
    const cleaned = cleanDocumentText(text);
    return res.json({ cleaned });
  } catch (err) {
    console.error("Clean endpoint error:", err);
    return res.status(500).json({ error: "Failed to clean text", details: err.message });
  }
});

/**
 * Endpoint 2: Summarize text
 */
app.post("/api/summarize", (req, res) => {
  try {
    const { text, length = "medium", tone = "standard" } = req.body;
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ detail: "No document text was provided." });
    }

    const result = summarizeText(text, length, tone);
    return res.json(result);
  } catch (err) {
    console.error("Summarize endpoint error:", err);
    return res.status(500).json({ detail: "Failed to generate summary", error: err.message });
  }
});

/**
 * Endpoint 3: Upload document/image for OCR extraction and text cleaning
 */
app.post("/api/ocr", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file was uploaded." });
    }

    const result = await parseDocument(req.file.buffer, req.file.originalname, req.file.mimetype);
    return res.json(result);
  } catch (err) {
    console.error("OCR endpoint error:", err);
    return res.status(500).json({ error: "Failed to parse document / perform OCR", details: err.message });
  }
});

/**
 * Endpoint 4: End-to-end Process Document (Upload -> OCR -> Clean -> Summarize)
 */
app.post("/api/process-document", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file was uploaded." });
    }

    const length = req.body.length || "medium";
    const tone = req.body.tone || "standard";

    const parsed = await parseDocument(req.file.buffer, req.file.originalname, req.file.mimetype);
    if (!parsed.text || !parsed.text.trim()) {
      return res.status(422).json({ error: "No readable text could be extracted from this document." });
    }

    const summaryResult = summarizeText(parsed.text, length, tone);

    return res.json({
      filename: parsed.filename,
      extracted_text: parsed.text,
      summary: summaryResult.summary,
      key_points: summaryResult.key_points,
      keywords: summaryResult.keywords,
      metrics: summaryResult.metrics,
      meta: parsed.meta
    });
  } catch (err) {
    console.error("Process document endpoint error:", err);
    return res.status(500).json({ error: "Failed to process and summarize document", details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Node.js OCR & NLP Backend running on http://localhost:${PORT}`);
});

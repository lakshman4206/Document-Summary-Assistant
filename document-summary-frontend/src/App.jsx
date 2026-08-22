import { useState } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createWorker } from "tesseract.js";
import "./App.css";

GlobalWorkerOptions.workerSrc = pdfWorker;

function App() {
  const [file, setFile] = useState(null);
  const [summaryLength, setSummaryLength] = useState("medium");
  const [summary, setSummary] = useState("");
  const [keyPoints, setKeyPoints] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  const handleFile = (selectedFile) => {
    if (!selectedFile) return;

    const allowedTypes = [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/jpg",
      "image/webp",
    ];

    if (!allowedTypes.includes(selectedFile.type)) {
      setError("Please upload a PDF, JPG, PNG, or WEBP file.");
      return;
    }

    setFile(selectedFile);
    setSummary("");
    setKeyPoints([]);
    setError("");
    setProgress("");
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);

    const droppedFile = e.dataTransfer.files[0];
    handleFile(droppedFile);
  };

  const extractTextFromPDF = async (pdfFile) => {
    const arrayBuffer = await pdfFile.arrayBuffer();

    const pdf = await getDocument({
      data: arrayBuffer,
    }).promise;

    let text = "";

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      setProgress(`Reading PDF page ${pageNumber} of ${pdf.numPages}...`);

      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();

      const pageText = content.items
        .map((item) => item.str)
        .join(" ");

      text += pageText + "\n";
    }

    return text.trim();
  };

  const extractTextFromImage = async (imageFile) => {
    setProgress("Running OCR on the image...");

    const worker = await createWorker("eng");

    const {
      data: { text },
    } = await worker.recognize(imageFile);

    await worker.terminate();

    return text.trim();
  };

  const cleanText = (text) => {
    return text
      .replace(/\s+/g, " ")
      .replace(/\n+/g, " ")
      .trim();
  };

  const createSummary = (text, length) => {
    const cleanedText = cleanText(text);

    if (!cleanedText) {
      return {
        summary: "No readable text was found in this document.",
        keyPoints: [],
      };
    }

    const sentences = cleanedText
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 30);

    if (sentences.length === 0) {
      return {
        summary: cleanedText,
        keyPoints: [],
      };
    }

    const stopWords = new Set([
      "the",
      "is",
      "a",
      "an",
      "and",
      "or",
      "of",
      "to",
      "in",
      "for",
      "on",
      "with",
      "that",
      "this",
      "are",
      "was",
      "were",
      "as",
      "by",
      "from",
      "at",
      "be",
      "has",
      "have",
      "it",
      "its",
      "their",
      "they",
      "these",
      "those",
      "but",
      "not",
      "can",
      "will",
    ]);

    const words = cleanedText
      .toLowerCase()
      .replace(/[^a-zA-Z0-9\s]/g, "")
      .split(/\s+/)
      .filter((word) => word.length > 3 && !stopWords.has(word));

    const frequency = {};

    words.forEach((word) => {
      frequency[word] = (frequency[word] || 0) + 1;
    });

    const scoredSentences = sentences.map((sentence, index) => {
      const sentenceWords = sentence
        .toLowerCase()
        .replace(/[^a-zA-Z0-9\s]/g, "")
        .split(/\s+/);

      let score = 0;

      sentenceWords.forEach((word) => {
        score += frequency[word] || 0;
      });

      if (index < 2) {
        score += 2;
      }

      return {
        sentence,
        score,
        index,
      };
    });

    const sentenceCount =
      length === "short"
        ? 3
        : length === "medium"
        ? 6
        : 10;

    const selected = [...scoredSentences]
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(sentenceCount, sentences.length))
      .sort((a, b) => a.index - b.index);

    const finalSummary = selected
      .map((item) => item.sentence)
      .join(" ");

    const points = [...scoredSentences]
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(5, sentences.length))
      .map((item) => item.sentence);

    return {
      summary: finalSummary,
      keyPoints: points,
    };
  };

  const generateSummary = async () => {
    if (!file) {
      setError("Please upload a document first.");
      return;
    }

    setLoading(true);
    setError("");
    setSummary("");
    setKeyPoints([]);

    try {
      let extractedText = "";

      if (file.type === "application/pdf") {
        extractedText = await extractTextFromPDF(file);

        if (!extractedText.trim()) {
          setProgress("PDF has no selectable text. OCR would be required.");
          throw new Error(
            "This PDF appears to be scanned. Upload the scanned pages as images for OCR in this frontend version."
          );
        }
      } else {
        extractedText = await extractTextFromImage(file);
      }

      if (!extractedText.trim()) {
        throw new Error("No readable text was found.");
      }

      setProgress("Generating summary...");

      const result = createSummary(
        extractedText,
        summaryLength
      );

      setSummary(result.summary);
      setKeyPoints(result.keyPoints);
      setProgress("Summary generated successfully.");
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  const removeFile = () => {
    setFile(null);
    setSummary("");
    setKeyPoints([]);
    setError("");
    setProgress("");
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-content">
          <h1>Document Summary Assistant</h1>
          <p>
            Upload a PDF or image and get an instant summary
          </p>
        </div>
      </header>

      <main className="container">
        <section className="card">
          <h2>Upload Document</h2>

          <div
            className={`drop-zone ${isDragging ? "dragging" : ""}`}
            onDrop={handleDrop}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
          >
            <div className="upload-icon">📄</div>

            <h3>Drag & Drop your document</h3>

            <p>or</p>

            <label className="file-button">
              Choose File
              <input
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.webp"
                onChange={(e) =>
                  handleFile(e.target.files[0])
                }
              />
            </label>

            <span className="file-info">
              PDF, JPG, PNG, WEBP
            </span>
          </div>

          {file && (
            <div className="selected-file">
              <div className="file-details">
                <span className="file-icon">📎</span>

                <div>
                  <strong>{file.name}</strong>

                  <p>
                    {(
                      file.size /
                      1024 /
                      1024
                    ).toFixed(2)}{" "}
                    MB
                  </p>
                </div>
              </div>

              <button
                className="remove-button"
                onClick={removeFile}
              >
                Remove
              </button>
            </div>
          )}

          {error && <div className="error">{error}</div>}

          {progress && (
            <div className="progress">
              {progress}
            </div>
          )}
        </section>

        <section className="card">
          <h2>Summary Length</h2>

          <div className="summary-options">
            {["short", "medium", "long"].map((length) => (
              <button
                key={length}
                className={`summary-option ${
                  summaryLength === length
                    ? "active"
                    : ""
                }`}
                onClick={() =>
                  setSummaryLength(length)
                }
              >
                <strong>
                  {length.charAt(0).toUpperCase() +
                    length.slice(1)}
                </strong>

                <span>
                  {length === "short" &&
                    "Quick overview"}

                  {length === "medium" &&
                    "Main ideas and details"}

                  {length === "long" &&
                    "Detailed explanation"}
                </span>
              </button>
            ))}
          </div>

          <button
            className="generate-button"
            onClick={generateSummary}
            disabled={loading}
          >
            {loading
              ? "⏳ Processing Document..."
              : "✨ Generate Summary"}
          </button>
        </section>

        {summary && (
          <section className="card">
            <div className="result-header">
              <h2>Summary</h2>

              <button
                className="download-button"
                onClick={() => {
                  const blob = new Blob(
                    [summary],
                    { type: "text/plain" }
                  );

                  const url =
                    URL.createObjectURL(blob);

                  const a =
                    document.createElement("a");

                  a.href = url;
                  a.download = "summary.txt";
                  a.click();

                  URL.revokeObjectURL(url);
                }}
              >
                Download
              </button>
            </div>

            <div className="summary-text">
              {summary}
            </div>
          </section>
        )}

        {keyPoints.length > 0 && (
          <section className="card">
            <h2>Key Points</h2>

            <div className="key-points">
              {keyPoints.map((point, index) => (
                <div
                  className="key-point"
                  key={index}
                >
                  <span>{index + 1}</span>
                  <p>{point}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {summary && (
          <section className="card">
            <h2>Improvement Suggestions</h2>

            <div className="suggestions">
              <div>
                💡 Make important sections more concise.
              </div>

              <div>
                💡 Use clear headings for major topics.
              </div>

              <div>
                💡 Remove repeated information where possible.
              </div>
            </div>
          </section>
        )}
      </main>

      <footer>
        Document Summary Assistant © 2026
      </footer>
    </div>
  );
}

export default App;
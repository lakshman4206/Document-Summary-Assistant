export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ detail: 'Method not allowed' });
  }

  const { text, length = 'medium', tone = 'standard' } = req.body || {};

  if (!text || !text.trim()) {
    return res.status(400).json({ detail: 'No document text was provided.' });
  }

  const hfToken = process.env.HF_TOKEN;

  let minLength = 40;
  let maxLength = 140;

  if (length === 'short') {
    minLength = 25;
    maxLength = 75;
  } else if (length === 'long') {
    minLength = 90;
    maxLength = 260;
  }

  try {
    // Truncate input to avoid model context limit
    const cleanInput = text.trim().slice(0, 4000);

    const response = await fetch('https://router.huggingface.co/hf-inference/models/facebook/bart-large-cnn', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${hfToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        inputs: cleanInput,
        parameters: {
          min_length: minLength,
          max_length: maxLength,
          do_sample: false
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Hugging Face API Error:', errorText);
      return res.status(response.status).json({ detail: `AI API Error: ${response.statusText}`, raw: errorText });
    }

    const data = await response.json();
    let summaryText = '';

    if (Array.isArray(data) && data[0]?.summary_text) {
      summaryText = data[0].summary_text.trim();
    } else if (data.summary_text) {
      summaryText = data.summary_text.trim();
    } else {
      throw new Error('Unexpected response format from AI provider.');
    }

    // Extract structured key points from summary sentences
    const sentences = summaryText
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 15);

    let keyPoints = sentences.slice(0, length === 'short' ? 2 : length === 'long' ? 6 : 4);
    if (keyPoints.length === 0) {
      keyPoints = [summaryText];
    }

    if (tone === 'bullet') {
      summaryText = sentences.map((s) => `• ${s}`).join('\n\n');
    }

    return res.status(200).json({
      summary: summaryText,
      key_points: keyPoints,
      provider: 'facebook/bart-large-cnn'
    });
  } catch (err) {
    console.error('AI summarization error:', err);
    return res.status(500).json({ detail: err.message || 'AI summarization failed' });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ detail: 'Method not allowed' });
  }

  const { text, length = 'medium', tone = 'standard' } = req.body || {};

  if (!text || !text.trim()) {
    return res.status(400).json({
      detail: 'No document text was provided.'
    });
  }

  const endpoints = [
    'http://localhost:5000/api/summarize',
    'https://document-summary-assistant-ekuy.onrender.com/api/summarize'
  ];

  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: text.trim(),
          length,
          tone
        })
      });

      if (response.ok) {
        const data = await response.json();
        return res.status(200).json(data);
      }
    } catch (error) {
      // try next
    }
  }

  return res.status(500).json({
    detail: 'Unable to connect to the summarization backend.'
  });
}
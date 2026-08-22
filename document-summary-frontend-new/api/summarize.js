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

  const { text, length = 'medium' } = req.body || {};

  if (!text || !text.trim()) {
    return res.status(400).json({
      detail: 'No document text was provided.'
    });
  }

  try {
    const response = await fetch(
      'https://document-summary-assistant-ekuy.onrender.com/api/summarize',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: text.trim(),
          length
        })
      }
    );

    const data = await response.json();

    return res.status(response.status).json(data);
  } catch (error) {
    console.error('Backend API error:', error);

    return res.status(500).json({
      detail: 'Unable to connect to the summarization backend.'
    });
  }
}
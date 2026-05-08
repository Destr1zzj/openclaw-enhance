/**
 * MiniMax Embedding Client
 * 使用 MiniMax embo-01 模型生成 1536 维 embedding
 */

const API_KEY = process.env.MINIMAX_API_KEY || '';
const ENDPOINT = 'https://api.minimaxi.com/v1/embeddings';
const MODEL = 'embo-01';
const DIM = 1536;

async function embed(texts) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: MODEL, texts, type: 'db' })
  });
  const json = await res.json();
  if (json.base_resp && json.base_resp.status_code !== 0) {
    throw new Error(`Embedding failed: ${json.base_resp.status_msg}`);
  }
  return json.vectors; // array of float[1536]
}

async function embedQuery(text) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: MODEL, texts: [text], type: 'query' })
  });
  const json = await res.json();
  if (json.base_resp && json.base_resp.status_code !== 0) {
    throw new Error(`Embedding failed: ${json.base_resp.status_msg}`);
  }
  return json.vectors[0]; // single query vector
}

module.exports = { embed, embedQuery, DIM };
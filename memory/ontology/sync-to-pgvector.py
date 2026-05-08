#!/usr/bin/env python3
"""
sync-to-pgvector.py
将 graph.jsonl 中的实体同步到 PostgreSQL pgvector 表
使用 MiniMax embo-01 embeddings
"""

import json
import sys
import subprocess

API_KEY = import_os.environ.get('MINIMAX_API_KEY', '')
ENDPOINT = 'https://api.minimaxi.com/v1/embeddings'
MODEL = 'embo-01'
DIM = 1536

GRAPH_FILE = '/root/.openclaw/workspace/memory/ontology/graph.jsonl'
DB_CONFIG = {
    'host': '127.0.0.1',
    'port': 5432,
    'database': 'openclaw',
    'user': 'postgres',
    'password': import_os.environ.get('PG_PASSWORD', 'openclaw_pg_2026')
}

def embed(texts):
    """Call MiniMax embedding API"""
    import urllib.request
    import urllib.error

    payload = json.dumps({'model': MODEL, 'texts': texts, 'type': 'db'}).encode()
    req = urllib.request.Request(
        ENDPOINT,
        data=payload,
        headers={
            'Authorization': f'Bearer {API_KEY}',
            'Content-Type': 'application/json'
        },
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
        if data.get('base_resp', {}).get('status_code') != 0:
            raise Exception(f"Embedding failed: {data['base_resp']['status_msg']}")
        return data['vectors']

def embed_query(text):
    """Call MiniMax embedding API for query"""
    import urllib.request

    payload = json.dumps({'model': MODEL, 'texts': [text], 'type': 'query'}).encode()
    req = urllib.request.Request(
        ENDPOINT,
        data=payload,
        headers={
            'Authorization': f'Bearer {API_KEY}',
            'Content-Type': 'application/json'
        },
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
        if data.get('base_resp', {}).get('status_code') != 0:
            raise Exception(f"Embedding failed: {data['base_resp']['status_msg']}")
        return data['vectors'][0]

def entity_to_text(e):
    p = e.get('properties', {})
    parts = [p.get('name'), p.get('title'), p.get('code'), p.get('status'),
             p.get('role'), p.get('summary'), p.get('description'), e.get('type'), e.get('id')]
    return ' '.join(x for x in parts if x)

def load_entities():
    with open(GRAPH_FILE, 'r', encoding='utf-8') as f:
        lines = [l.strip() for l in f if l.strip()]
    entities = []
    for line in lines:
        try:
            p = json.loads(line)
            if p.get('op') == 'delete':
                continue
            entities.append(p.get('entity', p))
        except:
            pass
    return entities

def main():
    import psycopg2
    import psycopg2.extras

    entities = load_entities()
    print(f'Loaded {len(entities)} entities from graph.jsonl')

    conn = psycopg2.connect(**DB_CONFIG)
    cur = conn.cursor()

    BATCH = 10
    total = 0

    for i in range(0, len(entities), BATCH):
        batch = entities[i:i+BATCH]
        texts = [entity_to_text(e) for e in batch]

        print(f'Embedding batch {i//BATCH+1}/{len(entities)//BATCH+1} ({len(texts)} texts)...')
        try:
            vectors = embed(texts)
        except Exception as err:
            print(f'❌ Embedding failed: {err}')
            sys.exit(1)

        for j, e in enumerate(batch):
            v = vectors[j]
            p = e.get('properties', {})
            text_content = entity_to_text(e)
            eid = e.get('id')

            if not eid:
                print(f'  Skipping entity without id at batch {i//BATCH+1} item {j}')
                continue

            cur.execute("""
                INSERT INTO knowledge_entities (id, entity_type, properties, text_content, embedding, updated_at)
                VALUES (%s, %s, %s, %s, %s::vector, NOW())
                ON CONFLICT (id) DO UPDATE SET
                    entity_type = EXCLUDED.entity_type,
                    properties = EXCLUDED.properties,
                    text_content = EXCLUDED.text_content,
                    embedding = EXCLUDED.embedding,
                    updated_at = NOW()
            """, [eid, e.get('type', 'unknown'), json.dumps(p), text_content, json.dumps(v)])

            total += 1

        conn.commit()
        print(f'  Indexed {total}/{len(entities)}')

    print(f'\n✅ Done! {total} entities indexed to pgvector.')
    cur.close()
    conn.close()

if __name__ == '__main__':
    main()
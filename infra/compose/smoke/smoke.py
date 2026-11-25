"""Real dependency smoke, synthetic data only; not domain acceptance tests."""
import asyncio
import base64
from datetime import timedelta
from decimal import Decimal
import hashlib
import hmac
import io
import json
import os
import time
import uuid

import boto3
from botocore.config import Config
from confluent_kafka import Consumer, Producer
from confluent_kafka.admin import AdminClient, NewTopic
from elasticsearch import Elasticsearch
import jsonschema
from PIL import Image
import pillow_heif
import psycopg
import redis
import requests
from temporalio.client import Client
from temporalio.worker import Worker
from workflow import SyntheticEcho

MARKER = "smoke-" + uuid.uuid4().hex
HTTP = requests.Session()
HTTP.trust_env = False


def ok(label):
    print("PASS " + label, flush=True)


def postgres():
    with psycopg.connect(host="postgres", dbname="tpa_dev", user="tpa_bootstrap",
                         password=os.environ["POSTGRES_PASSWORD"], connect_timeout=10) as db:
        assert db.execute("SHOW server_version").fetchone()[0].startswith("16.")
        extensions = dict(db.execute("SELECT extname, extversion FROM pg_extension").fetchall())
        assert {"vector", "pg_trgm", "pgcrypto"} <= extensions.keys()
        assert db.execute("SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector").fetchone()[0] == 1
        assert db.execute("SELECT similarity('synthetic','synthetic')").fetchone()[0] == 1
        assert db.execute("SELECT encode(digest('synthetic','sha256'),'hex')").fetchone()[0] == hashlib.sha256(b"synthetic").hexdigest()
        assert db.execute("SELECT '720000.00'::numeric(15,2)").fetchone()[0] == Decimal("720000.00")
        assert not db.execute("SELECT 1 FROM pg_roles WHERE rolname='temporal'").fetchall()
        assert not db.execute("SELECT 1 FROM pg_database WHERE datname LIKE 'temporal%'").fetchall()
        assert not db.execute("SELECT 1 FROM information_schema.tables WHERE table_schema='public'").fetchall()
        print("PostgreSQL extensions:", extensions)
    with psycopg.connect(host="temporal-db", dbname="temporal", user="temporal",
                         password=os.environ["TEMPORAL_DB_PASSWORD"], connect_timeout=10) as db:
        assert not db.execute("SELECT 1 FROM pg_database WHERE datname='tpa_dev'").fetchall()
        assert db.execute("SELECT 1 FROM information_schema.tables WHERE table_name='executions'").fetchone()
        assert db.execute("SELECT 1 FROM pg_database WHERE datname='temporal_visibility'").fetchone()
    ok("PostgreSQL16 extensions, exact numeric and separate Temporal persistence")


def cache():
    r = redis.Redis(host="redis", socket_timeout=5)
    assert r.info()["redis_version"].startswith("7.")
    assert r.set(MARKER, "synthetic", ex=60)
    assert r.get(MARKER) == b"synthetic"
    assert r.delete(MARKER) == 1
    ok("Redis7 SET/GET/DEL")


def storage_image():
    s3 = boto3.client("s3", endpoint_url="http://s3:8333", region_name="us-east-1",
                      aws_access_key_id=os.environ["S3_ACCESS_KEY"],
                      aws_secret_access_key=os.environ["S3_SECRET_KEY"],
                      config=Config(signature_version="s3v4", s3={"addressing_style": "path"},
                                    connect_timeout=5, read_timeout=10))
    bucket, key = "tpa-smoke", MARKER + ".heic"
    s3.create_bucket(Bucket=bucket)
    pillow_heif.register_heif_opener()
    buf = io.BytesIO()
    Image.new("RGB", (1600, 800), (40, 120, 180)).save(buf, format="HEIF", quality=50)
    original = buf.getvalue()
    try:
        url = s3.generate_presigned_url("put_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=60)
        HTTP.put(url, data=original, timeout=15).raise_for_status()
        assert s3.get_object(Bucket=bucket, Key=key)["Body"].read() == original
        assert HTTP.get(f"http://s3:8333/{bucket}/{key}", timeout=5).status_code in (401, 403)
        source = base64.urlsafe_b64encode(f"s3://{bucket}/{key}".encode()).decode().rstrip("=")
        path = f"/rs:fit:1200:0/{source}.webp"
        sig = base64.urlsafe_b64encode(hmac.new(bytes.fromhex(os.environ["IMGPROXY_KEY"]),
                bytes.fromhex(os.environ["IMGPROXY_SALT"]) + path.encode(), hashlib.sha256).digest()).decode().rstrip("=")
        response = HTTP.get("http://imgproxy:8080/" + sig + path, timeout=30)
        response.raise_for_status()
        image = Image.open(io.BytesIO(response.content))
        assert image.format == "WEBP" and image.size == (1200, 600)
        assert HTTP.get("http://imgproxy:8080/invalid" + path, timeout=5).status_code == 403
        assert s3.get_object(Bucket=bucket, Key=key)["Body"].read() == original
        ok("private S3 presigned upload/read; signed HEIC→WebP 1200px; original unchanged")
    finally:
        s3.delete_object(Bucket=bucket, Key=key)


def events():
    root = "http://registry:8080/apis/registry/v3/groups/default/artifacts"
    schema = {"$schema": "http://json-schema.org/draft-07/schema#", "type": "object",
              "properties": {"marker": {"type": "string"}}, "required": ["marker"], "additionalProperties": False}
    artifact = MARKER
    url = root + "/" + artifact
    def content(value):
        return {"content": json.dumps(value), "contentType": "application/json"}
    created = HTTP.post(root, json={"artifactId": artifact, "artifactType": "JSON",
                       "firstVersion": {"version": "1", "content": content(schema)}}, timeout=20)
    created.raise_for_status()
    admin = AdminClient({"bootstrap.servers": "kafka:9092"})
    topic = "tpa.dev." + MARKER
    try:
        fetched = HTTP.get(url + "/versions/1/content", timeout=10)
        fetched.raise_for_status()
        fetched_schema = fetched.json()
        assert fetched_schema == schema
        rule = HTTP.post(url + "/rules", json={"ruleType": "COMPATIBILITY", "config": "BACKWARD"}, timeout=10)
        rule.raise_for_status()
        incompatible = dict(schema, properties={"marker": {"type": "integer"}})
        rejected = HTTP.post(url + "/versions", json={"version": "2", "content": content(incompatible)}, timeout=10)
        assert rejected.status_code == 409, (rejected.status_code, rejected.text)
        payload = {"marker": MARKER}
        jsonschema.validate(payload, fetched_schema)
        for future in admin.create_topics([NewTopic(topic, num_partitions=1, replication_factor=1)]).values():
            future.result(timeout=20)
        producer = Producer({"bootstrap.servers": "kafka:9092", "enable.idempotence": True, "acks": "all"})
        delivery = []
        producer.produce(topic, key=MARKER, value=json.dumps(payload), on_delivery=lambda err, msg: delivery.append(err))
        assert producer.flush(20) == 0 and delivery == [None]
        consumer = Consumer({"bootstrap.servers": "kafka:9092", "group.id": MARKER, "auto.offset.reset": "earliest", "enable.auto.commit": False})
        try:
            consumer.subscribe([topic])
            deadline = time.monotonic() + 30
            message = None
            while time.monotonic() < deadline:
                message = consumer.poll(1)
                if message is not None:
                    assert not message.error(), message.error()
                    break
            assert message is not None, "Kafka consume deadline exceeded"
            assert json.loads(message.value()) == payload
            assert message.key().decode() == MARKER
            consumer.commit(message=message, asynchronous=False)
        finally:
            consumer.close()
        ok("Kafka KRaft produce/consume/commit; registry JSON Schema round-trip and incompatible version rejection")
    finally:
        HTTP.delete(url, timeout=10).raise_for_status()
        for future in admin.delete_topics([topic]).values():
            future.result(timeout=20)


def search():
    es = Elasticsearch("http://elasticsearch:9200", basic_auth=("elastic", os.environ["ELASTIC_PASSWORD"]), request_timeout=10)
    index = "tpa-" + MARKER
    assert HTTP.get("http://elasticsearch:9200", timeout=5).status_code == 401
    try:
        es.indices.create(index=index, mappings={"dynamic": "strict", "properties": {"marker": {"type": "keyword"}}})
        es.index(index=index, id=MARKER, document={"marker": MARKER}, refresh="wait_for")
        result = es.search(index=index, query={"term": {"marker": MARKER}})
        assert result["hits"]["total"]["value"] == 1
        ok("Elasticsearch authenticated strict mapping/index/search; anonymous denied")
    finally:
        es.indices.delete(index=index, ignore_unavailable=True)
        es.close()


async def temporal():
    client = await Client.connect("temporal:7233")
    async with Worker(client, task_queue=MARKER, workflows=[SyntheticEcho]):
        result = await client.execute_workflow(SyntheticEcho.run, MARKER, id=MARKER,
                                              task_queue=MARKER, execution_timeout=timedelta(seconds=30))
        assert result == MARKER
        handle = client.get_workflow_handle(MARKER)
        history = await handle.fetch_history()
        assert len(history.events) >= 5
    ok("Temporal SDK worker executes deterministic synthetic workflow with persisted history")


if __name__ == "__main__":
    postgres()
    cache()
    storage_image()
    events()
    search()
    asyncio.run(temporal())
    print("Dependency smoke complete. TC01–TC06 and PT01–PT24 NOT EXECUTED.")
